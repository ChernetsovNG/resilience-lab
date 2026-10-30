package resiliencelab.core.engine.ksl

import ksl.modeling.entity.KSLProcess
import ksl.modeling.entity.KSLProcessBuilder
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Executive
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.simulation.ModelElement
import ksl.utilities.observers.ObserverIfc
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.ServiceStep
import java.util.concurrent.CancellationException
import kotlin.time.Duration.Companion.seconds

/**
 * Builds and runs the KSL process model for one graph of the IR.
 * Original requests receive an absolute deadline at arrival, and service handlers remain seized through local
 * processing, synchronous downstream waits, retries, and backoff. A caller timeout or deadline ends only that
 * client's wait: admitted descendants continue, late responses are ignored, and no retry starts after the deadline.
 *
 * Arrivals stop at measurement end, but a replication finishes only after every original client outcome is known
 * and all accepted work, including orphaned work, has drained.
 * [selectTarget] resolves the target service for each edge attempt (numbered from one for each call step);
 * the default uses the edge target. Network and retry streams remain keyed by the original edge path.
 * A worker interruption stops the replication at an event boundary and raises [CancellationException] after
 * terminating suspended processes; cancelled work is never returned as a complete replication.
 */
class ReliabilityModel(
    model: Model,
    private val graph: GraphIr,
    private val streams: StreamSource,
    private val onReplicationCompleted: ((Int, ReplicationResult) -> Unit)? = null,
    onWindow: (
        Int,
        List<resiliencelab.core.results.NodeWindow>,
        List<resiliencelab.core.results.ConnectionWindow>,
    ) -> Unit = { _, _, _ -> },
    private val onOriginalCompletion: ((Double, Boolean) -> Unit)? = null,
    private val selectTarget: (CallEdge, Int) -> String = { call, _ -> call.to },
) : ProcessModel(model) {
    private val measurementStartMs = graph.run.warmupMs
    private val measurementEndMs = graph.run.warmupMs + graph.run.measurementMs

    val metrics =
        MetricsCollector(
            services = graph.topologicalServices,
            measurementStartMs = measurementStartMs,
            measurementEndMs = measurementEndMs,
            currentTimeMs = { time },
            clientId = graph.client.path,
            windowMs = graph.run.windowMs,
            connectionIds = graph.topologicalCalls.map { it.path } + graph.routes.map { it.path },
            onWindow = onWindow,
        )
    private val runtimes =
        graph.topologicalServices
            .map { service ->
                ServiceRuntime(
                    parent = this,
                    node = service,
                    streams = streams,
                    scenario = graph.scenario(service),
                    onAdmitted = ::recordAdmission,
                    onQueueLengthChanged = { queueLength ->
                        metrics.recordQueueLength(service.path, this@ReliabilityModel.time, queueLength)
                    },
                    onBusyHandlersChanged = { busyHandlers ->
                        metrics.recordBusyHandlers(service.path, this@ReliabilityModel.time, busyHandlers)
                    },
                )
            }.associateBy { it.serviceId }

    private val callRuntimes = graph.topologicalCalls.associate { it.path to CallRuntime(it, streams) }
    private val routerRuntimes = graph.routers.associate { it.path to RouterRuntime(it, graph.outgoingRoutes(it.path), streams) }

    var activeInvocations: Int = 0
        private set
    var activeOriginalRequests: Int = 0
        private set
    var activeDownstreamProcesses: Int = 0
        private set

    init {
        model.lengthOfReplication = Double.POSITIVE_INFINITY
        model.maximumAllowedExecutionTimePerReplication = graph.run.maxRealTimeSeconds.seconds
        executive.attachObserver(
            object : ObserverIfc<KSLEvent<*>?> {
                override fun onChange(newValue: KSLEvent<*>?) {
                    if (executive.status == Executive.Status.BEFORE_EVENT && Thread.currentThread().isInterrupted) {
                        stopReplication("Experiment was cancelled")
                    }
                }
            },
        )
    }

    override fun initialize() {
        metrics.reset()
        activeInvocations = 0
        activeOriginalRequests = 0
        activeDownstreamProcesses = 0
        runtimes.values.forEach { it.resetFaults() }
        callRuntimes.values.forEach { it.resetFaults() }
        routerRuntimes.values.forEach { it.reset() }
        scheduleWindowClose(1)
        schedule(
            eventAction =
                ModelElement.EventActionIfc<Nothing> {
                    metrics.startConnectionMeasurement()
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
        graph.faults.forEach { fault ->
            val runtime = runtimes[fault.target]
            val call = callRuntimes[fault.target]
            require(runtime != null || call != null) { "Unknown fault target '${fault.target}'" }
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime?.startFault(fault) ?: call!!.startFault(fault) },
                timeToEvent = fault.fromMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime?.endFault(fault) ?: call!!.endFault(fault) },
                timeToEvent = fault.toMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
        }
    }

    private fun scheduleWindowClose(number: Int) {
        val boundary = minOf(measurementEndMs, number.toDouble() * graph.run.windowMs)
        schedule(
            eventAction =
                ModelElement.EventActionIfc<Nothing> {
                    metrics.closeWindows(boundary)
                    if (boundary < measurementEndMs) scheduleWindowClose(number + 1)
                },
            timeToEvent = boundary - time,
            priority = KSLEvent.DEFAULT_PRIORITY - 2,
        )
    }

    private var workloadPrepared = false

    internal fun prepareWorkload() {
        if (workloadPrepared) return
        ArrivalGenerator(
            reliabilityModel = this,
            entryServiceId = graph.entry,
            arrivalRate = graph.client.arrivalRatePerMs,
            warmupMs = graph.run.warmupMs,
            measurementMs = graph.run.measurementMs,
            stream = streams.stream(graph.client.pathSegments, StreamRole.ARRIVALS),
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
        if (Thread.currentThread().isInterrupted) throw CancellationException("Experiment was cancelled")
        if (executive.isExecutionTimeExceeded) {
            throw ExperimentExecutionException("Replication exceeded its real-time cap before full drain")
        }
        if (workloadPrepared && !fullyDrained) {
            throw ExperimentExecutionException("Replication ended before the workload fully drained")
        }
        if (fullyDrained) metrics.verifyConnectionsDrained()
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
                (arrivalTimeMs + graph.client.deadlineMs).also { deadline ->
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
        incomingNetwork: CallRuntime?,
        selectedRoutes: List<RouteEdge> = emptyList(),
    ): ServiceInvocation {
        require(serviceId in runtimes || serviceId in routerRuntimes) { "Unknown service '$serviceId'" }
        val invocation =
            ServiceInvocation(
                target = serviceId,
                originalRequest = originalRequest,
                measurementCohort = measurementCohort,
                arrivalTimeMs = time + timeUntilActivation,
                originalDeadlineMs = originalDeadlineMs,
                incomingNetwork = incomingNetwork,
                initialRoutes = selectedRoutes,
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
        connectionId: String,
        retry: Boolean,
        timeoutMs: Double,
        selectedRoutes: List<RouteEdge>,
    ): CallAttempt {
        val sentMs = time
        val observed = listOf(connectionId) + selectedRoutes.map { it.path }

        fun record(
            event: ConnectionEvent,
            latencyMs: Double = 0.0,
        ) {
            observed.forEach { metrics.recordConnection(it, event, caller.measurementCohort, latencyMs) }
        }
        record(ConnectionEvent.SENT)
        if (retry) record(ConnectionEvent.RETRY)
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
                recordTimeout = { orphaned ->
                    metrics.recordTimeout(callingServiceId, caller.measurementCohort)
                    record(ConnectionEvent.TIMEOUT)
                    if (orphaned) record(ConnectionEvent.ORPHANED)
                },
                recordResponse = { succeeded ->
                    record(
                        if (succeeded) ConnectionEvent.SUCCEEDED else ConnectionEvent.FAILED,
                        time - sentMs,
                    )
                },
                recordOrphanCompleted = {
                    record(ConnectionEvent.ORPHAN_COMPLETED)
                },
            )
        child.incomingAttempt = attempt
        return attempt
    }

    private fun recordAdmission(entity: ProcessModel.Entity) {
        (entity as ServiceInvocation).recordAdmission()
    }

    inner class ServiceInvocation internal constructor(
        private val target: String,
        private val originalRequest: Boolean,
        internal val measurementCohort: Boolean,
        private val arrivalTimeMs: Double,
        private val originalDeadlineMs: Double,
        private val incomingNetwork: CallRuntime?,
        initialRoutes: List<RouteEdge>,
    ) : Entity() {
        private lateinit var runtime: ServiceRuntime
        private val selectedRoutes = initialRoutes.toMutableList()
        private var currentOutcome: AttemptOutcome = AttemptOutcome.PENDING
        private var originalOutcome: AttemptOutcome? = null
        private var originalClientActive = false
        private var admitted = false
        internal var incomingAttempt: CallAttempt? = null

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
            metrics.recordAdmitted(runtime.serviceId, measurementCohort)
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
            val succeeded = completedOutcome == AttemptOutcome.SUCCEEDED
            metrics.recordOriginalCompletion(
                arrivalTimeMs = arrivalTimeMs,
                completionTimeMs = time,
                succeeded = succeeded,
                measured = measurementCohort,
            )
            if (measurementCohort) onOriginalCompletion?.invoke(time - arrivalTimeMs, succeeded)
        }

        /** Runs ordered steps in this process while the caller keeps its handler allocation. */
        private suspend fun KSLProcessBuilder.executeScenario(): AttemptOutcome {
            for (step in runtime.scenario) {
                val outcome =
                    when (step) {
                        is ServiceStep.Process -> {
                            val durationMs = runtime.nextDurationMs(step)
                            val localFailure = runtime.nextLocalFailure(step)
                            delay(durationMs)
                            if (localFailure) {
                                metrics.recordLocalFailure(runtime.serviceId, measurementCohort)
                                AttemptOutcome.LOCAL_FAILURE
                            } else {
                                AttemptOutcome.SUCCEEDED
                            }
                        }
                        is ServiceStep.Call -> executeCall(callRuntimes.getValue(step.edge))
                    }
                if (outcome != AttemptOutcome.SUCCEEDED) return outcome
            }
            return AttemptOutcome.SUCCEEDED
        }

        private suspend fun KSLProcessBuilder.executeCall(callRuntime: CallRuntime): AttemptOutcome {
            val call = callRuntime.edge
            var attemptNumber = 1
            val triedOutputs = mutableMapOf<String, MutableSet<String>>()
            while (true) {
                if (time >= originalDeadlineMs) return AttemptOutcome.DEADLINE_EXCEEDED
                if (attemptNumber > 1) {
                    metrics.recordRetry(runtime.serviceId, measurementCohort)
                }
                val attempt = startAttempt(callRuntime, selectTarget(call, attemptNumber), attemptNumber, triedOutputs)
                callAttempt = attempt
                blockUntilCompleted(attempt.child.work)
                if (attempt.status == AttemptOutcome.PENDING) attempt.onChildCompleted()
                if (attempt.status == AttemptOutcome.SUCCEEDED) return AttemptOutcome.SUCCEEDED
                if (time >= originalDeadlineMs) return AttemptOutcome.DEADLINE_EXCEEDED
                if (attemptNumber == call.attempts) return attempt.status
                val backoffMs =
                    RetryPolicyEvaluator.backoffMs(
                        backoff = call.backoff,
                        failedAttemptNumber = attemptNumber,
                        jitter = { callRuntime.nextJitter() },
                    )
                metrics.recordConnection(call.path, ConnectionEvent.BACKOFF_STARTED, measurementCohort)
                try {
                    delay(minOf(backoffMs, originalDeadlineMs - time))
                } finally {
                    metrics.recordConnection(call.path, ConnectionEvent.BACKOFF_COMPLETED, measurementCohort)
                }
                attemptNumber++
            }
        }

        /** Starts one attempt against the selected service; routing is resolved anew before each retry. */
        private fun startAttempt(
            callRuntime: CallRuntime,
            target: String,
            attemptNumber: Int,
            triedOutputs: MutableMap<String, MutableSet<String>>,
        ): CallAttempt {
            val call = callRuntime.edge
            var selectedTarget = target
            val routes =
                buildList {
                    while (true) {
                        val router = routerRuntimes[selectedTarget] ?: break
                        val tried = triedOutputs.getOrPut(selectedTarget) { mutableSetOf() }
                        val eligible = if (call.retryTarget == RetryTarget.OTHER) tried else emptySet()
                        val policy = call.balancing?.takeIf { router.isReplicaGroup && selectedTarget == call.to }
                        val route = if (policy == null) router.select(eligible) else router.select(eligible, policy)
                        tried.add(route.path)
                        add(route)
                        selectedTarget = route.to
                    }
                }
            val child =
                createInvocation(
                    serviceId = selectedTarget,
                    timeUntilActivation = 0.0,
                    originalRequest = false,
                    measurementCohort = measurementCohort,
                    originalDeadlineMs = originalDeadlineMs,
                    incomingNetwork = callRuntime,
                    selectedRoutes = routes,
                )
            return createCallAttempt(
                caller = this,
                child = child,
                callingServiceId = runtime.serviceId,
                connectionId = call.path,
                retry = attemptNumber > 1,
                timeoutMs = minOf(call.timeoutMs, originalDeadlineMs - time),
                selectedRoutes = routes,
            )
        }

        internal val work: KSLProcess =
            process("service:$target") {
                try {
                    var selectedTarget = target
                    while (selectedTarget in routerRuntimes) {
                        val route = routerRuntimes.getValue(selectedTarget).select(emptySet())
                        selectedRoutes.add(route)
                        metrics.recordConnection(route.path, ConnectionEvent.SENT, measurementCohort)
                        selectedTarget = route.to
                    }
                    runtime = runtimes.getValue(selectedTarget)
                    if (incomingNetwork != null) {
                        val transmissionFailed = incomingNetwork.nextTransmissionFailed()
                        delay(incomingNetwork.nextNetworkDelayMs())
                        if (transmissionFailed) {
                            currentOutcome = AttemptOutcome.DOWNSTREAM_FAILURE
                            return@process
                        }
                    }
                    val serviceArrivalMs = time
                    metrics.recordOffered(runtime.serviceId, measurementCohort)
                    if (originalRequest) {
                        originalClientActive = true
                        activeOriginalRequests++
                        metrics.recordOriginalArrival(arrivalTimeMs, measurementCohort)
                    }
                    try {
                        val acquisition = with(runtime.slots) { acquire() }
                        val allocation = acquisition.allocation ?: throw QueueFullException(runtime.serviceId)
                        try {
                            currentOutcome = executeScenario()
                        } finally {
                            release(allocation)
                            if (currentOutcome != AttemptOutcome.PENDING) {
                                metrics.recordAttemptCompletion(
                                    runtime.serviceId,
                                    time - serviceArrivalMs,
                                    currentOutcome == AttemptOutcome.SUCCEEDED,
                                )
                            }
                        }
                    } catch (exception: QueueFullException) {
                        currentOutcome = AttemptOutcome.QUEUE_REJECTED
                        metrics.recordQueueRejection(runtime.serviceId, measurementCohort)
                    }
                    if (incomingNetwork != null) {
                        delay(incomingNetwork.nextNetworkDelayMs())
                    }
                } finally {
                    if (originalRequest) {
                        selectedRoutes.forEach { route ->
                            metrics.recordConnection(
                                route.path,
                                if ((originalOutcome ?: currentOutcome) ==
                                    AttemptOutcome.SUCCEEDED
                                ) {
                                    ConnectionEvent.SUCCEEDED
                                } else {
                                    ConnectionEvent.FAILED
                                },
                                measurementCohort,
                                time - arrivalTimeMs,
                            )
                        }
                    }
                    selectedRoutes.forEach { routerRuntimes.getValue(it.from).complete(it) }
                    incomingAttempt?.onChildProcessEnded()
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
