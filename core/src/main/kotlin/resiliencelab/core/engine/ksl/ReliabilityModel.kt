package resiliencelab.core.engine.ksl

import kotlinx.serialization.json.JsonPrimitive
import ksl.modeling.entity.KSLProcess
import ksl.modeling.entity.KSLProcessBuilder
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Executive
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.simulation.ModelElement
import ksl.utilities.observers.ObserverIfc
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.experiment.ReplicaGroups
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
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
            clientId = graph.clients.minBy { it.path }.path,
            clientIds = graph.clients.map { it.path },
            classIds = graph.clients.flatMap { it.classes.keys }.distinct(),
            windowMs = graph.run.windowMs,
            connectionIds = graph.topologicalCalls.map { it.path } + graph.routes.map { it.path },
            connectionPoolSizes = graph.topologicalCalls.mapNotNull { call -> call.pool?.let { call.path to it.size } }.toMap(),
            groups =
                ReplicaGroups.membership(graph),
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
                    onReadyChanged = { ready -> metrics.recordReadiness(service.path, ready) },
                    onSlotCapacityChanged = { set, capacity -> metrics.recordSlotCapacity(service.path, set, capacity) },
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

    private val callRuntimes = graph.topologicalCalls.associate { it.path to createCallRuntime(it) }

    private fun createCallRuntime(call: CallEdge): CallRuntime =
        CallRuntime(call, streams) { open ->
            metrics.recordCircuitState(call.path, open)
            if (open) {
                schedule(
                    eventAction = ModelElement.EventActionIfc<Nothing> { callRuntimes.getValue(call.path).circuitBreaker?.halfOpen() },
                    timeToEvent = requireNotNull(call.circuitBreaker).openDurationMs,
                    priority = KSLEvent.DEFAULT_PRIORITY - 1,
                )
            }
        }

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
                            onCapacityChanged = { metrics.recordSlotCapacity(call.path, "pool", it) },
                        )
                }
            }.toMap()
    private val routerRuntimes: Map<String, RouterRuntime> =
        graph.routers.associate { node ->
            node.path to
                RouterRuntime(
                    node,
                    graph.outgoingRoutes(node.path),
                    streams,
                    ::isTargetReady,
                    onEjected = { target, duration ->
                        metrics.recordEjection(target, true)
                        schedule(
                            eventAction = ModelElement.EventActionIfc<Nothing> { routerRuntimes.getValue(node.path).restore(target) },
                            timeToEvent = duration,
                            priority = KSLEvent.DEFAULT_PRIORITY - 1,
                        )
                    },
                    onReturned = { target -> metrics.recordEjection(target, false) },
                )
        }
    private val routeFaults = graph.routes.associate { it.path to FaultState() }

    private fun isTargetReady(
        path: String,
        requestClass: String,
    ): Boolean {
        runtimes[path]?.let { return it.ready }
        val routes = graph.outgoingRoutes(path, requestClass)
        return routes.isEmpty() || routes.any { isTargetReady(it.to, requestClass) }
    }

    var activeInvocations: Int = 0
        private set
    var activeOriginalRequests: Int = 0
        private set
    var activeDownstreamProcesses: Int = 0
        private set

    init {
        graph.topologicalServices.forEach { service ->
            service.healthCheck?.let { config ->
                HealthCheckProcess(
                    this,
                    runtimes.getValue(service.path),
                    config,
                    onStarted = { metrics.recordProbeStarted(service.path) },
                    onCompleted = { succeeded -> metrics.recordProbeCompleted(service.path, succeeded) },
                )
            }
        }
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
        graph.clients.sortedBy { it.path }.forEach { client ->
            client.classes.toSortedMap().forEach { (requestClass, load) ->
                val path = PathStreams.arrivalPath(client, requestClass)
                ArrivalGenerator(
                    reliabilityModel = this,
                    client = client,
                    requestClass = requestClass,
                    warmupMs = graph.run.warmupMs,
                    measurementMs = graph.run.measurementMs,
                    stream = streams.stream(path, StreamRole.ARRIVALS),
                    acceptanceStream = if (load.isConstant) null else streams.stream(path, StreamRole.ARRIVAL_ACCEPTANCE),
                )
            }
        }
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
            throw ExperimentExecutionException(
                CoreMessage.EXECUTION_REAL_TIME_LIMIT,
                "Replication exceeded its real-time cap before full drain (limit: ${graph.run.maxRealTimeSeconds} s)",
                mapOf("seconds" to JsonPrimitive(graph.run.maxRealTimeSeconds)),
            )
        }
        if (workloadPrepared && !fullyDrained) {
            throw ExperimentExecutionException(CoreMessage.EXECUTION_DRAIN, "Replication ended before the workload fully drained")
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

    /** Creates an invocation with the originating [client]'s deadline and [requestClass]. */
    fun invoke(
        serviceId: String,
        timeUntilActivation: Double = 0.0,
        originalRequest: Boolean = false,
        measurementCohort: Boolean = true,
        client: ClientNode = graph.clients.first(),
        requestClass: String = "default",
    ): ServiceInvocation {
        val arrivalTimeMs = time + timeUntilActivation
        if (!arrivalTimeMs.isFinite()) {
            throw ExperimentExecutionException(CoreMessage.EXECUTION_TIME_ARRIVAL, "Invocation arrival time must be finite")
        }
        val originalDeadlineMs =
            if (originalRequest) {
                (arrivalTimeMs + client.deadlineMs).also { deadline ->
                    if (!deadline.isFinite()) {
                        throw ExperimentExecutionException(CoreMessage.EXECUTION_TIME_DEADLINE, "Original request deadline must be finite")
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
            request = RequestContext(client.path, requestClass, arrivalTimeMs, originalDeadlineMs),
            incomingNetwork = null,
        )
    }

    private fun createInvocation(
        serviceId: String,
        timeUntilActivation: Double,
        originalRequest: Boolean,
        measurementCohort: Boolean,
        request: RequestContext,
        incomingNetwork: CallRuntime?,
        selectedRoutes: List<RouteEdge> = emptyList(),
    ): ServiceInvocation {
        require(serviceId in runtimes || serviceId in routerRuntimes) { "Unknown service '$serviceId'" }
        val invocation =
            ServiceInvocation(
                target = serviceId,
                originalRequest = originalRequest,
                measurementCohort = measurementCohort,
                request = request,
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
                    observed.forEach { metrics.recordConnectionFailure(it, AttemptOutcome.TIMED_OUT, caller.measurementCohort) }
                    record(ConnectionEvent.TIMEOUT)
                    if (orphaned) record(ConnectionEvent.ORPHANED)
                    // A timeout shortened by the original deadline is not evidence against the selected target.
                    if (time < caller.request.deadlineMs) child.observeRouting(AttemptOutcome.TIMED_OUT)
                },
                recordResponse = { outcome ->
                    child.observeRouting(outcome)
                    observed.forEach { metrics.recordConnectionFailure(it, outcome, caller.measurementCohort) }
                    record(
                        if (outcome == AttemptOutcome.SUCCEEDED) ConnectionEvent.SUCCEEDED else ConnectionEvent.FAILED,
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
        (entity as? ServiceInvocation)?.recordAdmission()
    }

    inner class ServiceInvocation internal constructor(
        private val target: String,
        private val originalRequest: Boolean,
        internal val measurementCohort: Boolean,
        val request: RequestContext,
        private val incomingNetwork: CallRuntime?,
        initialRoutes: List<RouteEdge>,
    ) : Entity() {
        private val arrivalTimeMs: Double get() = request.arrivalTimeMs
        private val originalDeadlineMs: Double get() = request.deadlineMs
        private lateinit var runtime: ServiceRuntime
        private val selectedRoutes = initialRoutes.toMutableList()
        private var currentOutcome: AttemptOutcome = AttemptOutcome.PENDING
        private var originalOutcome: AttemptOutcome? = null
        private var originalClientActive = false
        private var admitted = false
        private var routingCompleted = false
        private var routingObserved = false
        private var serviceOutcomeRecorded = false
        private var degraded = false
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

        internal fun observeRouting(outcome: AttemptOutcome) {
            if (routingObserved) return
            routingObserved = true
            if (!::runtime.isInitialized) return
            selectedRoutes.forEach { routerRuntimes.getValue(it.from).observe(it, outcome) }
        }

        private fun recordServiceOutcome() {
            if (serviceOutcomeRecorded || !::runtime.isInitialized) return
            serviceOutcomeRecorded = true
            metrics.recordServiceFailure(runtime.serviceId, currentOutcome, measurementCohort)
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
                clientId = request.clientId,
                requestClass = request.requestClass,
                failureReason = completedOutcome.failureReason,
                degraded = degraded,
            )
            if (measurementCohort) onOriginalCompletion?.invoke(time - arrivalTimeMs, succeeded)
        }

        /** Runs ordered steps in this process while the caller keeps its handler allocation. */
        private suspend fun KSLProcessBuilder.executeScenario(): AttemptOutcome {
            for (step in runtime.scenario) {
                if (step.classes != null && request.requestClass !in step.classes!!) continue
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
            val outcome = executeAttempts(callRuntime)
            val fallback = callRuntime.edge.fallback ?: return outcome
            if (outcome == AttemptOutcome.SUCCEEDED ||
                outcome == AttemptOutcome.DEADLINE_EXCEEDED ||
                outcome.failureReason !in fallback.on
            ) {
                return outcome
            }
            if (time >= originalDeadlineMs) return AttemptOutcome.DEADLINE_EXCEEDED
            val remainingMs = originalDeadlineMs - time
            delay(minOf(fallback.processingMs, remainingMs))
            if (fallback.processingMs > remainingMs) return AttemptOutcome.DEADLINE_EXCEEDED
            metrics.recordConnection(callRuntime.edge.path, ConnectionEvent.FALLBACK, measurementCohort)
            degraded = true
            return AttemptOutcome.SUCCEEDED
        }

        private suspend fun KSLProcessBuilder.executeAttempts(callRuntime: CallRuntime): AttemptOutcome {
            val call = callRuntime.edge
            var attemptNumber = 1
            var lastOutcome = AttemptOutcome.PENDING
            val triedOutputs = mutableMapOf<String, MutableSet<String>>()
            while (true) {
                if (time >= originalDeadlineMs) return AttemptOutcome.DEADLINE_EXCEEDED
                if (attemptNumber > 1) {
                    if (callRuntime.retryBudget?.allowsRetry(time) == false) {
                        metrics.recordConnection(call.path, ConnectionEvent.RETRY_DENIED, measurementCohort)
                        return lastOutcome
                    }
                    metrics.recordRetry(runtime.serviceId, measurementCohort)
                }
                val breaker = callRuntime.circuitBreaker
                val permit = breaker?.acquire()
                val outcome =
                    if (breaker != null && permit == null) {
                        metrics.recordConnection(call.path, ConnectionEvent.CIRCUIT_REJECTED, measurementCohort)
                        metrics.recordConnectionFailure(call.path, AttemptOutcome.CIRCUIT_OPEN, measurementCohort)
                        AttemptOutcome.CIRCUIT_OPEN
                    } else {
                        callRuntime.retryBudget?.recordAttempt(time, retry = attemptNumber > 1)
                        executeAttempt(callRuntime, attemptNumber, triedOutputs).also { result ->
                            if (permit != null) breaker.complete(permit, result == AttemptOutcome.SUCCEEDED)
                        }
                    }
                lastOutcome = outcome
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

        private suspend fun KSLProcessBuilder.executeAttempt(
            callRuntime: CallRuntime,
            attemptNumber: Int,
            triedOutputs: MutableMap<String, MutableSet<String>>,
        ): AttemptOutcome {
            val call = callRuntime.edge
            val pool = connectionPools[call.path]
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
            if (pool != null && acquisition?.allocation == null) {
                val outcome = if (time >= originalDeadlineMs) AttemptOutcome.DEADLINE_EXCEEDED else AttemptOutcome.ACQUIRE_TIMED_OUT
                metrics.recordConnectionFailure(call.path, outcome, measurementCohort)
                return outcome
            }
            return try {
                if (time >= originalDeadlineMs) {
                    AttemptOutcome.DEADLINE_EXCEEDED
                } else {
                    val attempt = startAttempt(callRuntime, selectTarget(call, attemptNumber), attemptNumber, triedOutputs)
                    callAttempt = attempt
                    blockUntilCompleted(attempt.child.work)
                    if (attempt.status == AttemptOutcome.PENDING && attempt.child.noResponse) awaitAttemptTimeout()
                    if (attempt.status == AttemptOutcome.PENDING) attempt.onChildCompleted()
                    if (attempt.status == AttemptOutcome.SUCCEEDED && attempt.child.degraded) degraded = true
                    attempt.status
                }
            } finally {
                acquisition?.allocation?.let { release(it) }
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
                        val route =
                            if (policy == null) {
                                router.select(eligible, requestClass = request.requestClass)
                            } else {
                                router.select(eligible, policy, request.requestClass)
                            } ?: break
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
                    request = request,
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
                    if (originalRequest) {
                        originalClientActive = true
                        activeOriginalRequests++
                        metrics.recordOriginalArrival(arrivalTimeMs, measurementCohort, request.clientId, request.requestClass)
                    }
                    var selectedTarget = target
                    while (selectedTarget in routerRuntimes) {
                        val router = routerRuntimes.getValue(selectedTarget)
                        val route =
                            router.select(emptySet(), requestClass = request.requestClass)
                        if (route == null) {
                            currentOutcome =
                                if (router.hasRoute(request.requestClass)) AttemptOutcome.NO_READY_TARGET else AttemptOutcome.NO_ROUTE
                            return@process
                        }
                        selectedRoutes.add(route)
                        metrics.recordConnection(route.path, ConnectionEvent.SENT, measurementCohort)
                        selectedTarget = route.to
                    }
                    runtime = runtimes.getValue(selectedTarget)
                    val transmissionStates = selectedRoutes.map { routeFaults.getValue(it.path) } + listOfNotNull(incomingNetwork?.faults)
                    if (transmissionStates.any { it.blackhole }) {
                        blackhole()
                        return@process
                    }
                    if (transmissionStates.any { it.unavailable }) {
                        currentOutcome = AttemptOutcome.UNAVAILABLE
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
                            currentOutcome = AttemptOutcome.LOCAL_FAILURE
                            return@process
                        }
                    }
                    if (runtime.faults.blackhole) {
                        blackhole()
                        return@process
                    }
                    if (runtime.faults.unavailable) {
                        currentOutcome = AttemptOutcome.UNAVAILABLE
                        return@process
                    }
                    val serviceArrivalMs = time
                    metrics.recordOffered(runtime.serviceId, measurementCohort)
                    if (runtime.rateLimit?.acquire(time) == false) {
                        currentOutcome = AttemptOutcome.RATE_LIMITED
                        metrics.recordRateLimited(runtime.serviceId, measurementCohort)
                        if (incomingNetwork != null || selectedRoutes.isNotEmpty()) {
                            val networkDelayMs = nextNetworkDelayMs()
                            if (incomingNetwork != null || networkDelayMs > 0.0) delay(networkDelayMs)
                        }
                        return@process
                    }
                    try {
                        val acquisition = with(runtime.slots) { acquire() }
                        if (runtime.serverSlots == null) metrics.recordHandlerAcquisition(runtime.serviceId, acquisition, measurementCohort)
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
                                    currentOutcome =
                                        if (acquired.outcome ==
                                            SlotAcquisitionOutcome.WAIT_LIMIT
                                        ) {
                                            AttemptOutcome.ACQUIRE_TIMED_OUT
                                        } else {
                                            AttemptOutcome.QUEUE_REJECTED
                                        }
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
                                recordServiceOutcome()
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
                        recordServiceOutcome()
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
                    recordServiceOutcome()
                    if (originalRequest) {
                        observeRouting(originalOutcome ?: currentOutcome)
                        selectedRoutes.forEach { route ->
                            metrics.recordConnectionFailure(route.path, originalOutcome ?: currentOutcome, measurementCohort)
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
