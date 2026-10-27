package resiliencelab.core.simulation

import ksl.modeling.entity.KSLProcess
import ksl.modeling.entity.ProcessModel
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.simulation.ModelElement
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.Scenario
import kotlin.time.Duration.Companion.seconds

/**
 * Builds and runs the KSL process model for one chain of the IR.
 * Original requests receive an absolute deadline at arrival, and service handlers remain seized through local
 * processing, synchronous downstream waits, retries, and backoff. A caller timeout or deadline ends only that
 * client's wait: admitted descendants continue, late responses are ignored, and no retry starts after the deadline.
 *
 * Arrivals stop at measurement end, but a replication finishes only after every original client outcome is known
 * and all accepted work, including orphaned work, has drained.
 */
class ReliabilityModel(
    model: Model,
    private val chain: ChainIr,
    private val streams: StreamSource,
    private val onReplicationCompleted: ((Int, ReplicationResult) -> Unit)? = null,
) : ProcessModel(model) {
    /** MVP constructor: maps [scenario] onto the chain IR with the MVP stream numbering; removed together with the MVP API. */
    constructor(
        model: Model,
        scenario: Scenario,
        execution: Execution,
        onReplicationCompleted: ((Int, ReplicationResult) -> Unit)? = null,
    ) : this(
        model,
        LegacyScenarioAdapter.chain(scenario, execution),
        LegacyScenarioAdapter.streams(model, scenario, execution.seed),
        onReplicationCompleted,
    )

    private val measurementStartMs = chain.run.warmupMs
    private val measurementEndMs = chain.run.warmupMs + chain.run.measurementMs

    val metrics =
        MetricsCollector(
            services = chain.services,
            measurementStartMs = measurementStartMs,
            measurementEndMs = measurementEndMs,
            currentTimeMs = { time },
        )
    private val runtimes =
        chain.services
            .map { service ->
                ServiceRuntime(
                    parent = this,
                    node = service,
                    streams = streams,
                    outgoingCall = chain.outgoingCall(service.path),
                    onAdmitted = ::recordAdmission,
                    onQueueLengthChanged = { queueLength ->
                        metrics.recordQueueLength(service.path, this@ReliabilityModel.time, queueLength)
                    },
                    onBusyHandlersChanged = { busyHandlers ->
                        metrics.recordBusyHandlers(service.path, this@ReliabilityModel.time, busyHandlers)
                    },
                )
            }.associateBy { it.serviceId }

    var activeInvocations: Int = 0
        private set
    var activeOriginalRequests: Int = 0
        private set
    var activeDownstreamProcesses: Int = 0
        private set

    init {
        model.lengthOfReplication = Double.POSITIVE_INFINITY
        model.maximumAllowedExecutionTimePerReplication = chain.run.maxRealTimeSeconds.seconds
    }

    override fun initialize() {
        metrics.reset()
        activeInvocations = 0
        activeOriginalRequests = 0
        activeDownstreamProcesses = 0
        runtimes.values.forEach { it.resetFaults() }
        schedule(
            eventAction =
                ModelElement.EventActionIfc<Nothing> {
                    runtimes.values.forEach { runtime ->
                        metrics.startMeasurement(
                            serviceId = runtime.serviceId,
                            queueLength = runtime.queue.size,
                            busyHandlers = runtime.resource.numBusy,
                        )
                    }
                },
            timeToEvent = measurementStartMs,
            priority = KSLEvent.DEFAULT_PRIORITY - 1,
        )
        schedule(
            eventAction =
                ModelElement.EventActionIfc<Nothing> {
                    metrics.finishMeasurement(measurementEndMs)
                },
            timeToEvent = measurementEndMs,
            priority = KSLEvent.DEFAULT_PRIORITY - 1,
        )
        chain.faults.forEach { fault ->
            val runtime = runtimes.getValue(fault.target)
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime.startFault(fault) },
                timeToEvent = fault.fromMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime.endFault(fault) },
                timeToEvent = fault.toMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
        }
    }

    private var workloadPrepared = false

    internal fun prepareWorkload() {
        if (workloadPrepared) return
        ArrivalGenerator(
            reliabilityModel = this,
            entryServiceId = chain.entry,
            arrivalRate = chain.client.arrivalRatePerMs,
            warmupMs = chain.run.warmupMs,
            measurementMs = chain.run.measurementMs,
            stream = streams.stream(chain.client.path, StreamRole.ARRIVALS),
        )
        CompletionMonitor(
            reliabilityModel = this,
            arrivalEndMs = measurementEndMs,
        )
        workloadPrepared = true
    }

    override fun afterReplication() {
        val fullyDrained = isFullyDrained()
        super.afterReplication()
        if (executive.isExecutionTimeExceeded) {
            throw ExperimentExecutionException("Replication exceeded its real-time cap before full drain")
        }
        if (workloadPrepared && !fullyDrained) {
            throw ExperimentExecutionException("Replication ended before the workload fully drained")
        }
        onReplicationCompleted?.invoke(model.currentReplicationNumber, metrics.replicationResult())
    }

    private fun isFullyDrained(): Boolean =
        time >= measurementEndMs &&
            activeOriginalRequests == 0 &&
            activeInvocations == 0 &&
            activeDownstreamProcesses == 0

    fun runReplication(): ReplicationResult {
        prepareWorkload()
        model.numberOfReplications = 1
        model.simulate()
        return metrics.replicationResult()
    }

    fun invoke(
        serviceId: String,
        timeUntilActivation: Double = 0.0,
        originalRequest: Boolean = false,
        measurementCohort: Boolean = true,
    ): ServiceInvocation {
        val arrivalTimeMs = time + timeUntilActivation
        if (!arrivalTimeMs.isFinite()) {
            throw ExperimentExecutionException("Invocation arrival time must be finite")
        }
        val originalDeadlineMs =
            if (originalRequest) {
                (arrivalTimeMs + chain.client.deadlineMs).also { deadline ->
                    if (!deadline.isFinite()) {
                        throw ExperimentExecutionException("Original request deadline must be finite")
                    }
                }
            } else {
                Double.POSITIVE_INFINITY
            }
        return createInvocation(
            serviceId = serviceId,
            timeUntilActivation = timeUntilActivation,
            originalRequest = originalRequest,
            measurementCohort = measurementCohort,
            originalDeadlineMs = originalDeadlineMs,
            incomingNetwork = null,
        )
    }

    private fun createInvocation(
        serviceId: String,
        timeUntilActivation: Double,
        originalRequest: Boolean,
        measurementCohort: Boolean,
        originalDeadlineMs: Double,
        incomingNetwork: ServiceRuntime?,
    ): ServiceInvocation {
        val runtime = requireNotNull(runtimes[serviceId]) { "Unknown service '$serviceId'" }
        val invocation =
            ServiceInvocation(
                runtime = runtime,
                originalRequest = originalRequest,
                measurementCohort = measurementCohort,
                arrivalTimeMs = time + timeUntilActivation,
                originalDeadlineMs = originalDeadlineMs,
                incomingNetwork = incomingNetwork,
            )
        activate(invocation.work, timeUntilActivation)
        if (incomingNetwork != null) {
            activeDownstreamProcesses++
        }
        return invocation
    }

    private fun createCallAttempt(
        caller: ServiceInvocation,
        child: ServiceInvocation,
        callingServiceId: String,
        timeoutMs: Double,
    ): CallAttempt {
        lateinit var attempt: CallAttempt
        val timeoutEvent =
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { attempt.onTimeout() },
                timeToEvent = timeoutMs,
                priority = KSLEvent.DEFAULT_PRIORITY + 1,
            )
        attempt =
            CallAttempt(
                child = child,
                timeoutEvent = timeoutEvent,
                caller = caller,
                recordTimeout = {
                    if (caller.measurementCohort) {
                        metrics.recordTimeout(callingServiceId)
                    }
                },
            )
        return attempt
    }

    private fun recordAdmission(entity: ProcessModel.Entity) {
        (entity as ServiceInvocation).recordAdmission()
    }

    inner class ServiceInvocation internal constructor(
        private val runtime: ServiceRuntime,
        private val originalRequest: Boolean,
        internal val measurementCohort: Boolean,
        private val arrivalTimeMs: Double,
        private val originalDeadlineMs: Double,
        private val incomingNetwork: ServiceRuntime?,
    ) : Entity() {
        private var currentOutcome: AttemptOutcome = AttemptOutcome.PENDING
        private var originalOutcome: AttemptOutcome? = null
        private var originalClientActive = false
        private var admitted = false

        private val deadlineEvent: KSLEvent<*>? =
            if (originalRequest) {
                schedule(
                    eventAction = ModelElement.EventActionIfc<Nothing> { onOriginalDeadline() },
                    timeToEvent = originalDeadlineMs - this@ReliabilityModel.time,
                    priority = KSLEvent.DEFAULT_PRIORITY + 2,
                )
            } else {
                null
            }

        internal var callAttempt: CallAttempt? = null
            private set

        val outcome: AttemptOutcome
            get() = originalOutcome ?: currentOutcome

        internal fun recordAdmission() {
            check(!admitted) { "Invocation was already admitted" }
            admitted = true
            activeInvocations++
            if (measurementCohort) {
                metrics.recordAdmitted(runtime.serviceId)
            }
        }

        private fun onOriginalDeadline() {
            if (!originalClientActive || originalOutcome != null) return
            originalOutcome = AttemptOutcome.DEADLINE_EXCEEDED
            recordOriginalCompletion()
        }

        private fun completeOriginalProcess() {
            if (!originalClientActive) return
            if (currentOutcome == AttemptOutcome.PENDING) {
                originalClientActive = false
                activeOriginalRequests--
                return
            }
            if (originalOutcome == null) {
                originalOutcome =
                    if (time > originalDeadlineMs) {
                        AttemptOutcome.DEADLINE_EXCEEDED
                    } else {
                        currentOutcome
                    }
            }
            recordOriginalCompletion()
            if (deadlineEvent?.isScheduled == true) {
                deadlineEvent.cancel = true
            }
        }

        private fun recordOriginalCompletion() {
            val completedOutcome = requireNotNull(originalOutcome)
            originalClientActive = false
            activeOriginalRequests--
            if (measurementCohort) {
                metrics.recordOriginalCompletion(
                    arrivalTimeMs = arrivalTimeMs,
                    completionTimeMs = time,
                    succeeded = completedOutcome == AttemptOutcome.SUCCEEDED,
                )
            }
        }

        internal val work: KSLProcess =
            process("service:${runtime.serviceId}") {
                try {
                    if (incomingNetwork != null) {
                        delay(incomingNetwork.nextNetworkDelayMs())
                    }
                    if (measurementCohort) {
                        metrics.recordOffered(runtime.serviceId)
                    }
                    if (originalRequest) {
                        originalClientActive = true
                        activeOriginalRequests++
                        if (measurementCohort) {
                            metrics.recordOriginalArrival(arrivalTimeMs)
                        }
                    }
                    try {
                        val allocation = seize(runtime.resource)
                        try {
                            val durationMs = runtime.nextDurationMs()
                            val localFailure = runtime.nextLocalFailure()
                            delay(durationMs)
                            if (localFailure) {
                                currentOutcome = AttemptOutcome.LOCAL_FAILURE
                                if (measurementCohort) {
                                    metrics.recordLocalFailure(runtime.serviceId)
                                }
                            } else {
                                val call = runtime.outgoingCall
                                if (call == null) {
                                    currentOutcome = AttemptOutcome.SUCCEEDED
                                } else if (time >= originalDeadlineMs) {
                                    currentOutcome = AttemptOutcome.DEADLINE_EXCEEDED
                                } else {
                                    var attemptNumber = 1
                                    while (true) {
                                        if (time >= originalDeadlineMs) {
                                            currentOutcome = AttemptOutcome.DEADLINE_EXCEEDED
                                            break
                                        }
                                        if (attemptNumber > 1 && measurementCohort) {
                                            metrics.recordRetry(runtime.serviceId)
                                        }
                                        val child =
                                            createInvocation(
                                                serviceId = call.to,
                                                timeUntilActivation = 0.0,
                                                originalRequest = false,
                                                measurementCohort = measurementCohort,
                                                originalDeadlineMs = originalDeadlineMs,
                                                incomingNetwork = runtime,
                                            )
                                        val attempt =
                                            createCallAttempt(
                                                caller = this@ServiceInvocation,
                                                child = child,
                                                callingServiceId = runtime.serviceId,
                                                timeoutMs = minOf(call.timeoutMs, originalDeadlineMs - time),
                                            )
                                        callAttempt = attempt
                                        blockUntilCompleted(child.work)
                                        if (attempt.status == AttemptOutcome.PENDING) {
                                            attempt.onChildCompleted()
                                        }
                                        if (attempt.status == AttemptOutcome.SUCCEEDED) {
                                            currentOutcome = AttemptOutcome.SUCCEEDED
                                            break
                                        }
                                        if (time >= originalDeadlineMs) {
                                            currentOutcome = AttemptOutcome.DEADLINE_EXCEEDED
                                            break
                                        }
                                        if (attemptNumber == call.attempts) {
                                            currentOutcome = attempt.status
                                            break
                                        }
                                        val backoffMs =
                                            RetryPolicyEvaluator.backoffMs(
                                                backoff = call.backoff,
                                                failedAttemptNumber = attemptNumber,
                                                jitter = { runtime.nextJitter() },
                                            )
                                        delay(minOf(backoffMs, originalDeadlineMs - time))
                                        attemptNumber++
                                    }
                                }
                            }
                        } finally {
                            release(allocation)
                        }
                    } catch (exception: QueueFullException) {
                        currentOutcome = AttemptOutcome.QUEUE_REJECTED
                        if (measurementCohort) {
                            metrics.recordQueueRejection(runtime.serviceId)
                        }
                    }
                    if (incomingNetwork != null) {
                        delay(incomingNetwork.nextNetworkDelayMs())
                    }
                } finally {
                    if (incomingNetwork != null) {
                        activeDownstreamProcesses--
                    }
                    if (admitted) {
                        activeInvocations--
                        admitted = false
                    }
                    if (originalRequest) {
                        completeOriginalProcess()
                    }
                }
            }
    }
}
