package resiliencelab.core.engine.ksl

import resiliencelab.core.experiment.EntryMetrics
import resiliencelab.core.experiment.LatencyAccumulator
import resiliencelab.core.experiment.ReplicaGroup
import resiliencelab.core.experiment.ReplicaGroups
import resiliencelab.core.experiment.ReplicationEntries
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.experiment.ServiceMetrics
import resiliencelab.core.experiment.TimeWeightedSeries
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.results.ConnectionWindow
import resiliencelab.core.results.NodeWindow

/**
 * Collects original-request outcomes and caused-attempt counters only for the measured arrival cohort, including
 * their run-out activity. Queue-length and handler series include all work present but cover only the fixed
 * measurement interval, so warm-up and run-out do not extend those time averages.
 * Call counters and response latency follow the same cohort; call occupancy uses the same fixed interval.
 */
class MetricsCollector(
    private val services: List<ServiceNode>,
    private val measurementStartMs: Double,
    private val measurementEndMs: Double,
    private val currentTimeMs: () -> Double,
    private val clientId: String = "client",
    private val clientIds: List<String> = listOf(clientId),
    private val classIds: List<String> = listOf("default"),
    private val windowMs: Double = (measurementEndMs - measurementStartMs) / 100.0,
    private val connectionIds: List<String> = emptyList(),
    private val connectionPoolSizes: Map<String, Int> = emptyMap(),
    private val groups: List<ReplicaGroup> = emptyList(),
    private val onWindow: (Int, List<NodeWindow>, List<ConnectionWindow>) -> Unit = { _, _, _ -> },
) {
    private val arrivalTimesMs = mutableListOf<Double>()
    private var totalEntry = EntryCollector("total")
    private var clientEntries = clientIds.sorted().associateWith { EntryCollector("client=$it") }
    private var classEntries = classIds.distinct().sorted().associateWith { EntryCollector("class=$it") }
    private val groupedWindow: (Int, List<NodeWindow>, List<ConnectionWindow>) -> Unit = { index, nodes, calls ->
        onWindow(
            index,
            nodes + ReplicaGroups.nodeWindows(groups, nodes, clientIds = clientIds),
            calls + ReplicaGroups.connectionWindows(groups, calls),
        )
    }
    private var windows =
        WindowCollector(
            clientId,
            services,
            measurementEndMs,
            windowMs,
            connectionIds,
            connectionPoolSizes,
            clientIds,
            classIds,
            groupedWindow,
        )
    private var connections = ConnectionCollector(connectionIds, measurementStartMs, measurementEndMs, connectionPoolSizes)
    private var poolerMetrics = newPoolerMetrics()
    private val serviceMetrics =
        services.filter { it.pooler == null }.associateTo(linkedMapOf()) { service ->
            service.path to MutableServiceMetrics(service.handlers, measurementStartMs, measurementEndMs)
        }

    fun replicationResult(): ReplicationResult {
        val timeMs = currentTimeMs()
        if (timeMs >= measurementEndMs) {
            finishMeasurement(timeMs)
        }
        return ReplicaGroups.replication(
            groups,
            ReplicationResult(
                arrivalTimesMs = arrivalTimesMs.toList(),
                entries =
                    ReplicationEntries(
                        totalEntry.snapshot(),
                        clientEntries.mapValues { it.value.snapshot() },
                        classEntries.mapValues { it.value.snapshot() },
                    ),
                services = serviceMetrics.mapValues { (_, metrics) -> metrics.snapshot() },
                connections = connections.snapshot(),
                poolers = poolerMetrics.mapValues { it.value.snapshot() },
            ),
        )
    }

    internal fun reset() {
        arrivalTimesMs.clear()
        totalEntry = EntryCollector("total")
        clientEntries = clientIds.sorted().associateWith { EntryCollector("client=$it") }
        classEntries = classIds.distinct().sorted().associateWith { EntryCollector("class=$it") }
        windows =
            WindowCollector(
                clientId,
                services,
                measurementEndMs,
                windowMs,
                connectionIds,
                connectionPoolSizes,
                clientIds,
                classIds,
                groupedWindow,
            )
        connections = ConnectionCollector(connectionIds, measurementStartMs, measurementEndMs, connectionPoolSizes)
        serviceMetrics.values.forEach { it.reset() }
        poolerMetrics = newPoolerMetrics()
    }

    internal fun startMeasurement(
        serviceId: String,
        queueLength: Int,
        busyHandlers: Int,
    ) {
        poolerMetrics[serviceId]?.let { pooler ->
            pooler.clients.record(measurementStartMs, busyHandlers.toDouble())
            pooler.clientSlots.start()
            return
        }
        val metrics = serviceMetrics.getValue(serviceId)
        metrics.slots.start()
        metrics.queueLengthSeries.record(measurementStartMs, queueLength.toDouble())
        metrics.busyHandlerSeries.record(measurementStartMs, busyHandlers.toDouble())
    }

    internal fun recordQueueLength(
        serviceId: String,
        timeMs: Double,
        queueLength: Int,
    ) {
        if (serviceId in poolerMetrics) return
        windows.queueLength(serviceId, timeMs, queueLength)
        serviceMetrics.getValue(serviceId).queueLengthSeries.record(timeMs, queueLength.toDouble())
    }

    internal fun recordBusyHandlers(
        serviceId: String,
        timeMs: Double,
        busyHandlers: Int,
    ) {
        windows.busyHandlers(serviceId, timeMs, busyHandlers)
        val pooler = poolerMetrics[serviceId]
        if (pooler == null) {
            serviceMetrics.getValue(serviceId).busyHandlerSeries.record(timeMs, busyHandlers.toDouble())
        } else {
            pooler.clients.record(timeMs, busyHandlers.toDouble())
        }
    }

    internal fun recordSlotCapacity(
        id: String,
        set: String,
        capacity: Int,
    ) {
        val now = currentTimeMs()
        windows.slotCapacity(id, set, now, capacity)
        when (set) {
            "handlers" -> serviceMetrics.getValue(id).slots.capacity(now, capacity)
            "serverConnections" -> poolerMetrics.getValue(id).serverSlots.capacity(now, capacity)
            "clientConnections" -> poolerMetrics.getValue(id).clientSlots.capacity(now, capacity)
            "pool" -> connections.poolCapacity(id, now, capacity)
        }
    }

    internal fun recordHandlerAcquisition(
        id: String,
        acquisition: SlotAcquisition,
        measured: Boolean,
    ) {
        windows.handlerAcquisition(id, currentTimeMs(), acquisition)
        if (measured) serviceMetrics[id]?.slots?.completed(acquisition)
    }

    internal fun finishMeasurement(timeMs: Double) {
        serviceMetrics.values.forEach { it.finish(timeMs) }
        connections.finish(timeMs)
        poolerMetrics.values.forEach { it.finish(timeMs) }
        if (timeMs >= measurementEndMs) windows.finish()
    }

    internal fun startConnectionMeasurement() {
        connections.startMeasurement()
    }

    internal fun recordConnection(
        id: String,
        event: ConnectionEvent,
        measured: Boolean,
        latencyMs: Double = 0.0,
    ) {
        val timeMs = currentTimeMs()
        windows.connectionEvent(id, timeMs, event, latencyMs)
        connections.record(id, timeMs, event, measured, latencyMs)
    }

    internal fun recordPoolState(
        id: String,
        busy: Int? = null,
        queueLength: Int? = null,
    ) {
        val timeMs = currentTimeMs()
        windows.poolState(id, timeMs, busy, queueLength)
        connections.poolState(id, timeMs, busy, queueLength)
    }

    internal fun recordPoolWait(
        id: String,
        measured: Boolean,
        waitMs: Double,
        expired: Boolean,
    ) {
        windows.poolWait(id, currentTimeMs(), waitMs, expired)
        connections.poolWait(id, measured, waitMs, expired)
    }

    internal fun verifyConnectionsDrained() {
        connections.verifyDrained()
    }

    internal fun closeWindows(timeMs: Double) {
        windows.closeThrough(timeMs)
    }

    internal fun recordOriginalArrival(
        timeMs: Double,
        measured: Boolean = true,
        clientId: String = this.clientId,
        requestClass: String = "default",
    ) {
        windows.originalArrival(timeMs, clientId, requestClass)
        if (measured) {
            arrivalTimesMs += timeMs
            listOf(totalEntry, clientEntries.getValue(clientId), classEntries.getValue(requestClass)).forEach { it.originalArrivals++ }
        }
    }

    internal fun recordOriginalCompletion(
        arrivalTimeMs: Double,
        completionTimeMs: Double,
        succeeded: Boolean,
        measured: Boolean = true,
        clientId: String = this.clientId,
        requestClass: String = "default",
        failureReason: String? = if (succeeded) null else "error",
    ) {
        val latencyMs = completionTimeMs - arrivalTimeMs
        windows.originalCompletion(completionTimeMs, latencyMs, succeeded, clientId, requestClass, failureReason)
        if (!measured) return
        listOf(totalEntry, clientEntries.getValue(clientId), classEntries.getValue(requestClass)).forEach {
            it.complete(latencyMs, succeeded, failureReason)
        }
    }

    internal fun recordServiceFailure(
        serviceId: String,
        outcome: AttemptOutcome,
        measured: Boolean,
    ) {
        val reason = outcome.failureReason ?: return
        windows.failure(serviceId, currentTimeMs(), reason)
        if (measured) serviceMetrics[serviceId]?.failuresByReason?.let { it[reason] = it.getOrDefault(reason, 0) + 1 }
    }

    internal fun recordConnectionFailure(
        id: String,
        outcome: AttemptOutcome,
        measured: Boolean,
    ) {
        val reason = outcome.failureReason ?: return
        windows.connectionFailure(id, currentTimeMs(), reason)
        connections.failure(id, reason, measured)
    }

    internal fun recordOffered(
        serviceId: String,
        measured: Boolean = true,
    ) {
        windows.attemptEvent(serviceId, currentTimeMs(), AttemptEvent.OFFERED)
        if (measured) {
            val pooler = poolerMetrics[serviceId]
            if (pooler == null) serviceMetrics.getValue(serviceId).offeredAttempts++ else pooler.offered++
        }
    }

    internal fun recordAdmitted(
        serviceId: String,
        measured: Boolean = true,
    ) {
        windows.attemptEvent(serviceId, currentTimeMs(), AttemptEvent.ADMITTED)
        if (measured) {
            val pooler = poolerMetrics[serviceId]
            if (pooler == null) serviceMetrics.getValue(serviceId).admittedAttempts++ else pooler.admitted++
        }
    }

    internal fun recordLocalFailure(
        serviceId: String,
        measured: Boolean = true,
    ) {
        if (measured) serviceMetrics[serviceId]?.let { it.failures++ }
    }

    internal fun recordQueueRejection(
        serviceId: String,
        measured: Boolean = true,
    ) {
        val pooler = poolerMetrics[serviceId]
        if (pooler == null) {
            windows.attemptEvent(serviceId, currentTimeMs(), AttemptEvent.QUEUE_REJECTED)
            if (measured) serviceMetrics.getValue(serviceId).queueRejections++
        } else {
            windows.poolerClientRejection(serviceId, currentTimeMs())
            if (measured) pooler.clientRejections++
        }
    }

    internal fun recordTimeout(
        serviceId: String,
        measured: Boolean = true,
    ) {
        windows.attemptEvent(serviceId, currentTimeMs(), AttemptEvent.TIMEOUT)
        if (measured) serviceMetrics[serviceId]?.let { it.timeouts++ }
    }

    internal fun recordRetry(
        serviceId: String,
        measured: Boolean = true,
    ) {
        windows.attemptEvent(serviceId, currentTimeMs(), AttemptEvent.RETRY)
        if (measured) serviceMetrics[serviceId]?.let { it.retries++ }
    }

    internal fun recordAttemptCompletion(
        serviceId: String,
        residenceMs: Double,
        succeeded: Boolean,
        measured: Boolean = true,
    ) {
        windows.attemptCompletion(serviceId, currentTimeMs(), residenceMs, succeeded)
        if (measured) {
            poolerMetrics[serviceId]?.complete(residenceMs, succeeded)
            serviceMetrics[serviceId]?.latency?.add(residenceMs)
        }
    }

    private fun newPoolerMetrics() =
        services.filter { it.pooler != null }.associate { node ->
            node.path to PoolerMetricsCollector(node, measurementStartMs, measurementEndMs)
        }

    internal fun startPoolerMeasurement(
        id: String,
        busy: Int,
        queued: Int,
    ) {
        poolerMetrics.getValue(id).apply {
            serverSlots.start()
            servers.record(measurementStartMs, busy.toDouble())
            queue.record(measurementStartMs, queued.toDouble())
        }
    }

    internal fun recordPoolerServerBusy(
        id: String,
        busy: Int,
    ) {
        windows.poolerServerBusy(id, currentTimeMs(), busy)
        poolerMetrics.getValue(id).servers.record(currentTimeMs(), busy.toDouble())
    }

    internal fun recordPoolerQueue(
        id: String,
        queued: Int,
    ) {
        windows.queueLength(id, currentTimeMs(), queued)
        poolerMetrics.getValue(id).queue.record(currentTimeMs(), queued.toDouble())
    }

    internal fun recordPoolerWait(
        id: String,
        acquisition: SlotAcquisition,
        measured: Boolean,
    ) {
        windows.poolerWait(id, currentTimeMs(), acquisition)
        if (measured) poolerMetrics.getValue(id).waitCompleted(acquisition)
    }

    private class EntryCollector(
        context: String,
    ) {
        private val allLatency = LatencyAccumulator(context = "$context cohort all")
        private val successfulLatency = LatencyAccumulator(context = "$context cohort successful")
        private val failedLatency = LatencyAccumulator(context = "$context cohort failed")
        var originalArrivals = 0
        private var successes = 0
        private var failures = 0
        private val reasons = sortedMapOf<String, Int>()

        fun complete(
            latencyMs: Double,
            succeeded: Boolean,
            reason: String?,
        ) {
            allLatency.add(latencyMs)
            if (succeeded) {
                successfulLatency.add(latencyMs)
                successes++
            } else {
                failedLatency.add(latencyMs)
                failures++
                val code = requireNotNull(reason)
                reasons[code] = reasons.getOrDefault(code, 0) + 1
            }
        }

        fun snapshot() =
            EntryMetrics(
                allLatency.snapshot(),
                successfulLatency.snapshot(),
                failedLatency.snapshot(),
                originalArrivals,
                successes,
                failures,
                failuresByReason = reasons.toMap(),
            )
    }

    private class MutableServiceMetrics(
        private val configuredHandlers: Int,
        private val measurementStartMs: Double,
        private val measurementEndMs: Double,
    ) {
        var latency = LatencyAccumulator(context = "service cohort residence")
        var slots = SlotStatistics(measurementStartMs, measurementEndMs, configuredHandlers)
        var offeredAttempts = 0
        var admittedAttempts = 0
        var timeouts = 0
        var retries = 0
        var failures = 0
        val failuresByReason = sortedMapOf<String, Int>()
        var queueRejections = 0
        var queueLengthSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)
        var busyHandlerSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)

        fun reset() {
            latency = LatencyAccumulator(context = "service cohort residence")
            slots = SlotStatistics(measurementStartMs, measurementEndMs, configuredHandlers)
            offeredAttempts = 0
            admittedAttempts = 0
            timeouts = 0
            retries = 0
            failures = 0
            failuresByReason.clear()
            queueRejections = 0
            queueLengthSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)
            busyHandlerSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)
        }

        fun finish(timeMs: Double) {
            slots.finish(timeMs)
            queueLengthSeries.finish(timeMs)
            busyHandlerSeries.finish(timeMs)
        }

        fun snapshot(): ServiceMetrics =
            ServiceMetrics(
                offeredAttempts = offeredAttempts,
                admittedAttempts = admittedAttempts,
                timeouts = timeouts,
                retries = retries,
                failures = failures,
                failuresByReason = failuresByReason.toMap(),
                measurementMs = measurementEndMs - measurementStartMs,
                queueDurationsMs = queueLengthSeries.durations,
                latency = latency.snapshot(),
                slotPools =
                    mapOf(
                        "handlers" to
                            slots
                                .snapshot(
                                    busyHandlerSeries.integral,
                                    queueLengthSeries.integral,
                                ).copy(queueFullCount = queueRejections.toLong()),
                    ),
            )
    }
}
