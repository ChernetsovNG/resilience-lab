package io.github.chernetsovng.resiliencelab.core.simulation

import io.github.chernetsovng.resiliencelab.core.experiment.ReplicationResult
import io.github.chernetsovng.resiliencelab.core.scenario.Execution
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import ksl.modeling.entity.KSLProcess
import ksl.modeling.entity.ProcessModel
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.simulation.ModelElement
import kotlin.time.Duration.Companion.seconds

class ReliabilityModel(
    model: Model,
    private val scenario: Scenario,
    private val execution: Execution,
    private val onReplicationCompleted: ((Int, ReplicationResult) -> Unit)? = null,
) : ProcessModel(model) {
    private val randomStreams = model.streamProvider.apply {
        initialSeed(SeedFactory.seedVector(execution.seed))
    }
    val metrics = MetricsCollector(
        services = scenario.services,
        measurementStartMs = execution.warmupMs,
        measurementEndMs = execution.warmupMs + execution.measurementMs,
        currentTimeMs = { time },
    )
    private val outgoingLinks = scenario.links.mapIndexed { index, link ->
        val networkStreamNum = scenario.services.size * 2 + index + 1
        val jitterStreamNum = scenario.services.size * 2 + scenario.links.size + index + 1
        link.from to Triple(link, networkStreamNum, jitterStreamNum)
    }.toMap()
    private val runtimes = scenario.services.mapIndexed { index, service ->
        val outgoing = outgoingLinks[service.id]
        ServiceRuntime(
            parent = this,
            spec = service,
            degradation = scenario.degradation?.takeIf { it.serviceId == service.id },
            streamProvider = randomStreams,
            durationStreamNum = index * 2 + 1,
            failureStreamNum = index * 2 + 2,
            outgoingLink = outgoing?.first,
            networkStreamNum = outgoing?.second,
            jitterStreamNum = outgoing?.third,
            onAdmitted = ::recordAdmission,
            onQueueLengthChanged = { queueLength ->
                metrics.recordQueueLength(service.id, this@ReliabilityModel.time, queueLength)
            },
            onBusyHandlersChanged = { busyHandlers ->
                metrics.recordBusyHandlers(service.id, this@ReliabilityModel.time, busyHandlers)
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
        model.maximumAllowedExecutionTimePerReplication = execution.maxRealTimeSeconds.seconds
    }

    override fun initialize() {
        metrics.reset()
        activeInvocations = 0
        activeOriginalRequests = 0
        activeDownstreamProcesses = 0
        runtimes.values.forEach { it.resetDegradation() }
        val measurementStartMs = execution.warmupMs
        val measurementEndMs = execution.warmupMs + execution.measurementMs
        schedule(
            eventAction = ModelElement.EventActionIfc<Nothing> {
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
            eventAction = ModelElement.EventActionIfc<Nothing> {
                metrics.finishMeasurement(measurementEndMs)
            },
            timeToEvent = measurementEndMs,
            priority = KSLEvent.DEFAULT_PRIORITY - 1,
        )
        val degradation = scenario.degradation
        if (degradation != null) {
            val runtime = runtimes.getValue(degradation.serviceId)
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime.startDegradation() },
                timeToEvent = degradation.startMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime.endDegradation() },
                timeToEvent = degradation.endMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
        }
    }

    private var workloadPrepared = false

    internal fun prepareWorkload() {
        if (workloadPrepared) return
        ArrivalGenerator(
            reliabilityModel = this,
            entryServiceId = scenario.entry,
            arrivalRate = scenario.workload.arrivalRate,
            warmupMs = execution.warmupMs,
            measurementMs = execution.measurementMs,
            streamNum = scenario.services.size * 2 + scenario.links.size * 2 + 1,
        )
        CompletionMonitor(
            reliabilityModel = this,
            arrivalEndMs = execution.warmupMs + execution.measurementMs,
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
        time >= execution.warmupMs + execution.measurementMs &&
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
        return createInvocation(
            serviceId = serviceId,
            timeUntilActivation = timeUntilActivation,
            originalRequest = originalRequest,
            measurementCohort = measurementCohort,
            originalDeadlineMs = if (originalRequest) {
                arrivalTimeMs + scenario.workload.requestDeadlineMs
            } else {
                Double.POSITIVE_INFINITY
            },
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
        val invocation = ServiceInvocation(
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
        val timeoutEvent = schedule(
            eventAction = ModelElement.EventActionIfc<Nothing> { attempt.onTimeout() },
            timeToEvent = timeoutMs,
            priority = KSLEvent.DEFAULT_PRIORITY + 1,
        )
        attempt = CallAttempt(
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

        private val deadlineEvent: KSLEvent<*>? = if (originalRequest) {
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
                originalOutcome = if (time > originalDeadlineMs) {
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

        internal val work: KSLProcess = process("service:${runtime.serviceId}") {
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
                            val link = runtime.outgoingLink
                            if (link == null) {
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
                                    val child = createInvocation(
                                        serviceId = link.to,
                                        timeUntilActivation = 0.0,
                                        originalRequest = false,
                                        measurementCohort = measurementCohort,
                                        originalDeadlineMs = originalDeadlineMs,
                                        incomingNetwork = runtime,
                                    )
                                    val attempt = createCallAttempt(
                                        caller = this@ServiceInvocation,
                                        child = child,
                                        callingServiceId = runtime.serviceId,
                                        timeoutMs = minOf(link.timeoutMs, originalDeadlineMs - time),
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
                                    if (attemptNumber == link.maxAttempts) {
                                        currentOutcome = attempt.status
                                        break
                                    }
                                    val backoffMs = RetryPolicyEvaluator.backoffMs(
                                        retry = link.retry,
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
