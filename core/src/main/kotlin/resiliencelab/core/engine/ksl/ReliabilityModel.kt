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
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan
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
            connectionPoolSizes = graph.topologicalCalls.mapNotNull { call -> call.pool?.let { call.path to it.size } }.toMap(),
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
                    onServerQueueLengthChanged = { length -> metrics.recordPoolerQueue(service.path, length) },
                    onBusyServerConnectionsChanged = { busy -> metrics.recordPoolerServerBusy(service.path, busy) },
                )
            }.associateBy { it.serviceId }

    private val callRuntimes = graph.topologicalCalls.associate { it.path to CallRuntime(it, streams) }
    private val connectionPools =
        graph.topologicalCalls
            .mapNotNull { call ->
                call.pool?.let { pool ->
                    call.path to
                        SlotPool(
                            this,
                            "${call.path}:pool",
                            pool.size,
                            Int.MAX_VALUE,
                            pool.acquireTimeoutMs,
                            onQueueLengthChanged = { metrics.recordPoolState(call.path, queueLength = it) },
                            onBusyChanged = { metrics.recordPoolState(call.path, busy = it) },
                        )
                }
            }.toMap()
    private val routerRuntimes = graph.routers.associate { it.path to RouterRuntime(it, graph.outgoingRoutes(it.path), streams) }
    private val routeFaults = graph.routes.associate { it.path to FaultState() }

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
        routeFaults.values.forEach { it.clear() }
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
                        runtime.serverSlots?.let { server ->
                            metrics.startPoolerMeasurement(runtime.serviceId, server.resource.numBusy, server.queue.size)
                        }
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
            require(fault.target in runtimes || fault.target in callRuntimes || fault.target in routeFaults) {
                "Unknown fault target '${fault.target}'"
            }
            // Settle every fault boundary before KSL releases slots or resumes queued processing at this instant.
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { changeFault(fault, starting = true) },
                timeToEvent = fault.fromMs,
                priority = RELEASE_PRIORITY - 1,
            )
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { changeFault(fault, starting = false) },
                timeToEvent = fault.toMs,
                priority = RELEASE_PRIORITY - 1,
            )
        }
    }

    private fun changeFault(
        fault: FaultSpan,
        starting: Boolean,
    ) {
        val service = runtimes[fault.target]
        if (service != null) {
            if (starting) service.startFault(fault) else service.endFault(fault)
            return
        }
        val call = callRuntimes[fault.target]
        val state = call?.faults ?: routeFaults.getValue(fault.target)
        if (starting) state.start(fault) else state.end(fault)
        if (call != null && fault.kind == FaultKind.CAPACITY_LOSS) {
            connectionPools.getValue(fault.target).changeCapacity(state.capacity ?: requireNotNull(call.edge.pool).size)
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
            load = graph.client.load,
            warmupMs = graph.run.warmupMs,
            measurementMs = graph.run.measurementMs,
            stream = streams.stream(graph.client.pathSegments, StreamRole.ARRIVALS),
            acceptanceStream =
                if (graph.client.load.isConstant) {
                    null
                } else {
                    streams.stream(
                        graph.client.pathSegments,
                        StreamRole.ARRIVAL_ACCEPTANCE,
                    )
                },
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
        private var routingCompleted = false
        internal var incomingAttempt: CallAttempt? = null
        internal var noResponse: Boolean = false
            private set

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

        /** A blackholed attempt has no child work, but remains in flight at its selected outputs until timeout. */
        internal fun completeRouting() {
            if (routingCompleted) return
            routingCompleted = true
            selectedRoutes.forEach { routerRuntimes.getValue(it.from).complete(it) }
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
            val pool = connectionPools[call.path]
            var attemptNumber = 1
            val triedOutputs = mutableMapOf<String, MutableSet<String>>()
            while (true) {
                if (time >= originalDeadlineMs) return AttemptOutcome.DEADLINE_EXCEEDED
                if (attemptNumber > 1) {
                    metrics.recordRetry(runtime.serviceId, measurementCohort)
                }
                val acquisition =
                    pool?.let { slots ->
                        with(slots) { acquire(minOf(requireNotNull(call.pool).acquireTimeoutMs, originalDeadlineMs - time)) }
                    }
                if (acquisition?.outcome in listOf(SlotAcquisitionOutcome.WAITED, SlotAcquisitionOutcome.WAIT_LIMIT)) {
                    metrics.recordPoolWait(
                        call.path,
                        measurementCohort,
                        requireNotNull(acquisition).waitMs,
                        acquisition.outcome == SlotAcquisitionOutcome.WAIT_LIMIT && time < originalDeadlineMs,
                    )
                }
                val outcome =
                    if (pool != null && acquisition?.allocation == null) {
                        if (time >= originalDeadlineMs) AttemptOutcome.DEADLINE_EXCEEDED else AttemptOutcome.ACQUIRE_TIMED_OUT
                    } else {
                        try {
                            if (time >= originalDeadlineMs) {
                                AttemptOutcome.DEADLINE_EXCEEDED
                            } else {
                                val attempt = startAttempt(callRuntime, selectTarget(call, attemptNumber), attemptNumber, triedOutputs)
                                callAttempt = attempt
                                blockUntilCompleted(attempt.child.work)
                                if (attempt.status == AttemptOutcome.PENDING && attempt.child.noResponse) {
                                    awaitAttemptTimeout()
                                }
                                if (attempt.status == AttemptOutcome.PENDING) attempt.onChildCompleted()
                                attempt.status
                            }
                        } finally {
                            acquisition?.allocation?.let { release(it) }
                        }
                    }
                if (outcome == AttemptOutcome.SUCCEEDED) return outcome
                if (time >= originalDeadlineMs) return AttemptOutcome.DEADLINE_EXCEEDED
                if (attemptNumber == call.attempts) return outcome
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

        @Suppress("DEPRECATION") // The attempt timeout resumes the waiting caller through KSL's public process API.
        private suspend fun KSLProcessBuilder.awaitAttemptTimeout() {
            suspend()
        }

        private fun nextNetworkDelayMs(): Double {
            val states = selectedRoutes.map { routeFaults.getValue(it.path) }
            return incomingNetwork?.nextNetworkDelayMs(states) ?: states.sumOf { it.delayMs }
        }

        private suspend fun KSLProcessBuilder.blackhole() {
            noResponse = true
            if (originalRequest) {
                delay(maxOf(0.0, originalDeadlineMs - time))
                currentOutcome = AttemptOutcome.DEADLINE_EXCEEDED
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
                    if (originalRequest) {
                        originalClientActive = true
                        activeOriginalRequests++
                        metrics.recordOriginalArrival(arrivalTimeMs, measurementCohort)
                    }
                    val transmissionStates = selectedRoutes.map { routeFaults.getValue(it.path) } + listOfNotNull(incomingNetwork?.faults)
                    if (transmissionStates.any { it.blackhole }) {
                        blackhole()
                        return@process
                    }
                    if (transmissionStates.any { it.unavailable }) {
                        currentOutcome = AttemptOutcome.DOWNSTREAM_FAILURE
                        return@process
                    }
                    if (incomingNetwork != null || selectedRoutes.isNotEmpty()) {
                        val routeFailures =
                            selectedRoutes.map { route ->
                                routeFaults.getValue(route.path).failureProbability?.let { probability ->
                                    streams.stream(route.pathSegments, StreamRole.OUTCOME).randU01() < probability
                                } ?: false
                            }
                        val transmissionFailed = incomingNetwork?.nextTransmissionFailed() == true || routeFailures.any { it }
                        val networkDelayMs = nextNetworkDelayMs()
                        if (incomingNetwork != null || networkDelayMs > 0.0) delay(networkDelayMs)
                        if (transmissionFailed) {
                            currentOutcome = AttemptOutcome.DOWNSTREAM_FAILURE
                            return@process
                        }
                    }
                    if (runtime.faults.blackhole) {
                        blackhole()
                        return@process
                    }
                    if (runtime.faults.unavailable) {
                        currentOutcome = AttemptOutcome.LOCAL_FAILURE
                        return@process
                    }
                    val serviceArrivalMs = time
                    metrics.recordOffered(runtime.serviceId, measurementCohort)
                    try {
                        val acquisition = with(runtime.slots) { acquire() }
                        val allocation = acquisition.allocation ?: throw QueueFullException(runtime.serviceId)
                        try {
                            val server = runtime.serverSlots
                            if (server == null) {
                                currentOutcome = executeScenario()
                            } else {
                                val acquired = with(server) { acquire() }
                                metrics.recordPoolerWait(runtime.serviceId, acquired, measurementCohort)
                                val serverAllocation = acquired.allocation
                                if (serverAllocation == null) {
                                    currentOutcome = AttemptOutcome.QUEUE_REJECTED
                                } else {
                                    try {
                                        currentOutcome = executeScenario()
                                    } finally {
                                        release(serverAllocation)
                                    }
                                }
                                if (incomingNetwork != null || selectedRoutes.isNotEmpty()) {
                                    val networkDelayMs = nextNetworkDelayMs()
                                    if (incomingNetwork != null || networkDelayMs > 0.0) delay(networkDelayMs)
                                }
                            }
                        } finally {
                            release(allocation)
                            if (currentOutcome != AttemptOutcome.PENDING) {
                                metrics.recordAttemptCompletion(
                                    runtime.serviceId,
                                    time - serviceArrivalMs,
                                    currentOutcome == AttemptOutcome.SUCCEEDED,
                                    measurementCohort,
                                )
                            }
                        }
                    } catch (exception: QueueFullException) {
                        currentOutcome = AttemptOutcome.QUEUE_REJECTED
                        metrics.recordQueueRejection(runtime.serviceId, measurementCohort)
                        if (runtime.serverSlots != null && (incomingNetwork != null || selectedRoutes.isNotEmpty())) {
                            val networkDelayMs = nextNetworkDelayMs()
                            if (incomingNetwork != null || networkDelayMs > 0.0) delay(networkDelayMs)
                        }
                    }
                    if (runtime.serverSlots == null && (incomingNetwork != null || selectedRoutes.isNotEmpty())) {
                        val networkDelayMs = nextNetworkDelayMs()
                        if (incomingNetwork != null || networkDelayMs > 0.0) delay(networkDelayMs)
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
                    if (!noResponse || incomingAttempt?.status != AttemptOutcome.PENDING) completeRouting()
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
