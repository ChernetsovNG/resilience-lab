package resiliencelab.core.engine.ksl

import resiliencelab.core.experiment.LatencyAccumulator
import resiliencelab.core.experiment.SlotPoolMetrics
import resiliencelab.core.ir.PoolerSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.windowCount
import resiliencelab.core.results.ConnectionWindow
import resiliencelab.core.results.ConnectionWindowMetrics
import resiliencelab.core.results.NodeWindow
import resiliencelab.core.results.WindowMetrics

internal enum class AttemptEvent { OFFERED, ADMITTED, QUEUE_REJECTED, TIMEOUT, RETRY }

/**
 * Owns only one open event-time window. Integrals carry queue/handler state across boundaries; closed rows are
 * delivered synchronously and released. Events at a boundary belong to the next window; events at end/run-out
 * are excluded. The last window records its actual (possibly shorter) duration.
 * Call occupancy carries in-flight, orphaned and backoff state across these same window boundaries.
 */
internal class WindowCollector(
    private val clientId: String,
    services: List<ServiceNode>,
    private val endMs: Double,
    private val windowMs: Double,
    connectionIds: List<String> = emptyList(),
    private val connectionPoolSizes: Map<String, Int> = emptyMap(),
    private val onWindow: (Int, List<NodeWindow>, List<ConnectionWindow>) -> Unit,
) {
    private val totalWindows = windowCount(endMs, windowMs)
    private var index = 0
    private var startMs = 0.0
    private var lastEventMs = 0.0
    private val nodes =
        (
            services.map {
                it.path to
                    State(
                        it.path,
                        if (it.pooler ==
                            null
                        ) {
                            it.handlers
                        } else {
                            0
                        },
                        it.pooler,
                        it.handlers,
                    )
            } + (clientId to State(clientId, 0))
        ).toMap().toSortedMap()
    private val connections = connectionIds.sorted().associateWith { ConnectionState(it) }

    fun connectionEvent(
        id: String,
        timeMs: Double,
        event: ConnectionEvent,
        latencyMs: Double,
    ) {
        if (!advance(timeMs)) return
        connections.getValue(id).apply {
            integrate(timeMs)
            record(event, latencyMs)
        }
    }

    fun poolState(
        id: String,
        timeMs: Double,
        busy: Int?,
        queueLength: Int?,
    ) {
        if (!advance(timeMs)) return
        connections.getValue(id).apply {
            integrate(timeMs)
            if (busy != null) poolBusy = busy
            if (queueLength != null) poolQueued = queueLength
        }
    }

    fun poolWait(
        id: String,
        timeMs: Double,
        waitMs: Double,
        expired: Boolean,
    ) {
        if (!advance(timeMs)) return
        connections.getValue(id).row.apply {
            poolWaitCount++
            poolWaitTimeMs += waitMs
            if (expired) poolAcquireTimeouts++
        }
    }

    fun slotCapacity(
        id: String,
        set: String,
        timeMs: Double,
        capacity: Int,
    ) {
        if (!advance(timeMs)) return
        if (set == "pool") {
            connections.getValue(id).apply {
                integratePoolCapacity(timeMs)
                poolSize = capacity
            }
        } else {
            nodes.getValue(id).apply {
                if (set == "serverConnections") {
                    if (serverCapacity != capacity) {
                        integrateServerCapacity(timeMs)
                        serverCapacity = capacity
                    }
                } else if (capacityValue != capacity) {
                    integrateCapacity(timeMs)
                    capacityValue = capacity
                }
            }
        }
    }

    fun handlerAcquisition(
        id: String,
        timeMs: Double,
        acquisition: SlotAcquisition,
    ) {
        if (!advance(timeMs)) return
        val row = nodes.getValue(id).row
        if (acquisition.outcome == SlotAcquisitionOutcome.WAITED || acquisition.outcome == SlotAcquisitionOutcome.WAIT_LIMIT) {
            row.waitCount++
            row.waitTime += acquisition.waitMs
        }
        if (acquisition.outcome == SlotAcquisitionOutcome.WAIT_LIMIT) row.waitTimeouts++
    }

    fun originalArrival(timeMs: Double) {
        if (advance(timeMs)) nodes.getValue(clientId).row.originalArrivals++
    }

    fun originalCompletion(
        timeMs: Double,
        latencyMs: Double,
        succeeded: Boolean,
    ) {
        if (!advance(timeMs)) return
        val row = nodes.getValue(clientId).row
        row.latency.add(latencyMs)
        if (succeeded) row.successes++ else row.failures++
    }

    fun attemptEvent(
        node: String,
        timeMs: Double,
        event: AttemptEvent,
    ) {
        if (!advance(timeMs)) return
        val row = nodes.getValue(node).row
        when (event) {
            AttemptEvent.OFFERED -> row.offeredAttempts++
            AttemptEvent.ADMITTED -> row.admittedAttempts++
            AttemptEvent.QUEUE_REJECTED -> row.queueRejections++
            AttemptEvent.TIMEOUT -> row.timeouts++
            AttemptEvent.RETRY -> row.retries++
        }
    }

    fun attemptCompletion(
        node: String,
        timeMs: Double,
        residenceMs: Double,
        succeeded: Boolean,
    ) {
        if (!advance(timeMs)) return
        val row = nodes.getValue(node).row
        row.latency.add(residenceMs)
        if (succeeded) row.successes++ else row.failures++
    }

    fun queueLength(
        node: String,
        timeMs: Double,
        length: Int,
    ) {
        if (!advance(timeMs)) return
        nodes.getValue(node).apply {
            integrate(timeMs)
            queue = length
        }
    }

    fun busyHandlers(
        node: String,
        timeMs: Double,
        busy: Int,
    ) {
        if (!advance(timeMs)) return
        nodes.getValue(node).apply {
            integrate(timeMs)
            this.busy = busy
        }
    }

    fun poolerServerBusy(
        id: String,
        timeMs: Double,
        busy: Int,
    ) {
        if (!advance(timeMs)) return
        nodes.getValue(id).apply {
            integrate(timeMs)
            serverBusy = busy
        }
    }

    fun poolerClientRejection(
        id: String,
        timeMs: Double,
    ) {
        if (advance(timeMs)) nodes.getValue(id).row.clientRejections++
    }

    fun poolerWait(
        id: String,
        timeMs: Double,
        acquisition: SlotAcquisition,
    ) {
        if (!advance(timeMs)) return
        val row = nodes.getValue(id).row
        if (acquisition.outcome == SlotAcquisitionOutcome.WAIT_LIMIT) row.waitTimeouts++
        if (acquisition.outcome in setOf(SlotAcquisitionOutcome.WAITED, SlotAcquisitionOutcome.WAIT_LIMIT)) {
            row.waitCount++
            row.waitTime += acquisition.waitMs
        }
    }

    fun finish() {
        if (startMs < endMs) advance(maxOf(endMs, lastEventMs))
    }

    fun closeThrough(timeMs: Double) {
        advance(timeMs)
    }

    private fun advance(timeMs: Double): Boolean {
        require(timeMs >= lastEventMs) { "Window events must be chronological" }
        lastEventMs = timeMs
        while (index < totalWindows) {
            val boundary = minOf(endMs, (index + 1).toDouble() * windowMs)
            check(boundary > startMs) { "Window boundary did not advance" }
            if (timeMs < boundary) break
            nodes.values.forEach {
                it.integrate(boundary)
                it.integrateCapacity(boundary)
                it.integrateServerCapacity(boundary)
            }
            connections.values.forEach { it.integrate(boundary) }
            onWindow(
                index,
                nodes.map { (id, state) -> NodeWindow(id, state.snapshot(boundary - startMs)) },
                connections.map { (id, state) -> ConnectionWindow(id, state.snapshot(boundary - startMs)) },
            )
            index++
            startMs = boundary
            nodes.values.forEach { it.row = Row(it.id, index) }
            connections.values.forEach { it.row = ConnectionRow(it.id, index) }
        }
        return timeMs < endMs
    }

    private inner class State(
        val id: String,
        val handlers: Int,
        val pooler: PoolerSettings? = null,
        val clientCapacity: Int = 0,
    ) {
        var row = Row(id, 0)
        var queue = 0
        var busy = 0
        var serverBusy = 0
        var capacityValue = if (pooler == null) handlers else clientCapacity
        var serverCapacity = pooler?.poolSize ?: 0
        private var lastCapacityMs = 0.0
        private var lastServerCapacityMs = 0.0
        private var lastMs = 0.0

        fun integrate(timeMs: Double) {
            val duration = timeMs - lastMs
            row.busyTime += busy * duration
            row.serverBusyTime += serverBusy * duration
            row.queueIntegral += queue * duration
            lastMs = timeMs
        }

        // Constant capacity uses the same one-product denominator as the preceding format.
        // Work events must not fragment capacity arithmetic; only its own changes and window edges do.
        fun integrateCapacity(timeMs: Double) {
            row.capacityTime += capacityValue * (timeMs - lastCapacityMs)
            lastCapacityMs = timeMs
        }

        fun integrateServerCapacity(timeMs: Double) {
            row.serverCapacityTime += serverCapacity * (timeMs - lastServerCapacityMs)
            lastServerCapacityMs = timeMs
        }

        fun snapshot(duration: Double): WindowMetrics =
            WindowMetrics(
                startMs = startMs,
                durationMs = duration,
                originalArrivals = row.originalArrivals,
                offeredAttempts = row.offeredAttempts,
                admittedAttempts = row.admittedAttempts,
                successes = row.successes,
                failures = row.failures,
                timeouts = row.timeouts,
                retries = row.retries,
                latency = row.latency.snapshot(),
                slotPools =
                    when {
                        pooler != null ->
                            mapOf(
                                "clientConnections" to
                                    SlotPoolMetrics(row.busyTime, 0.0, row.capacityTime, queueFullCount = row.clientRejections.toLong()),
                                "serverConnections" to
                                    SlotPoolMetrics(
                                        row.serverBusyTime,
                                        row.queueIntegral,
                                        row.serverCapacityTime,
                                        row.waitCount.toLong(),
                                        row.waitTime,
                                        0L,
                                        row.waitTimeouts.toLong(),
                                    ),
                            )
                        handlers > 0 ->
                            mapOf(
                                "handlers" to
                                    SlotPoolMetrics(
                                        row.busyTime,
                                        row.queueIntegral,
                                        row.capacityTime,
                                        row.waitCount.toLong(),
                                        row.waitTime,
                                        row.queueRejections.toLong(),
                                        row.waitTimeouts.toLong(),
                                    ),
                            )
                        else -> emptyMap()
                    },
            )
    }

    private class Row(
        node: String,
        window: Int,
    ) {
        var capacityTime = 0.0
        var serverCapacityTime = 0.0
        var clientRejections = 0
        var waitTimeouts = 0
        var serverBusyTime = 0.0
        var waitCount = 0
        var waitTime = 0.0
        var originalArrivals = 0
        var offeredAttempts = 0
        var admittedAttempts = 0
        var queueRejections = 0
        var successes = 0
        var failures = 0
        var timeouts = 0
        var retries = 0
        var busyTime = 0.0
        var queueIntegral = 0.0
        val latency = LatencyAccumulator(sparse = true, context = "node=$node window=$window")
    }

    private inner class ConnectionState(
        val id: String,
    ) {
        var row = ConnectionRow(id, 0)
        var poolBusy = 0
        var poolQueued = 0
        var poolSize = connectionPoolSizes[id] ?: 0
        private var inFlight = 0
        private var orphaned = 0
        private var backoff = 0
        private var lastMs = 0.0
        private var lastPoolCapacityMs = 0.0

        fun integrate(timeMs: Double) {
            val duration = timeMs - lastMs
            row.inFlightIntegral += inFlight * duration
            row.orphanedIntegral += orphaned * duration
            row.backoffIntegral += backoff * duration
            row.poolBusyTimeMs += poolBusy * duration
            row.poolQueueIntegralMs += poolQueued * duration
            integratePoolCapacity(timeMs)
            lastMs = timeMs
        }

        fun integratePoolCapacity(timeMs: Double) {
            row.poolCapacityTimeMs += poolSize * (timeMs - lastPoolCapacityMs)
            lastPoolCapacityMs = timeMs
        }

        fun record(
            event: ConnectionEvent,
            latencyMs: Double,
        ) {
            when (event) {
                ConnectionEvent.SENT -> {
                    row.sentAttempts++
                    inFlight++
                }
                ConnectionEvent.RETRY -> row.retries++
                ConnectionEvent.SUCCEEDED -> {
                    row.succeeded++
                    inFlight--
                    row.latency.add(latencyMs)
                }
                ConnectionEvent.FAILED -> {
                    row.failed++
                    inFlight--
                    row.latency.add(latencyMs)
                }
                ConnectionEvent.TIMEOUT -> {
                    row.timeouts++
                    inFlight--
                }
                ConnectionEvent.ORPHANED -> {
                    row.orphaned++
                    orphaned++
                }
                ConnectionEvent.ORPHAN_COMPLETED -> orphaned--
                ConnectionEvent.BACKOFF_STARTED -> backoff++
                ConnectionEvent.BACKOFF_COMPLETED -> backoff--
            }
        }

        fun snapshot(duration: Double): ConnectionWindowMetrics =
            ConnectionWindowMetrics(
                startMs,
                duration,
                row.sentAttempts,
                row.retries,
                row.succeeded,
                row.failed,
                row.timeouts,
                row.orphaned,
                row.inFlightIntegral,
                row.orphanedIntegral,
                row.backoffIntegral,
                row.latency.snapshot(),
                slotPools =
                    if (id in connectionPoolSizes) {
                        mapOf(
                            "pool" to
                                SlotPoolMetrics(
                                    row.poolBusyTimeMs,
                                    row.poolQueueIntegralMs,
                                    row.poolCapacityTimeMs,
                                    row.poolWaitCount.toLong(),
                                    row.poolWaitTimeMs,
                                    0L,
                                    row.poolAcquireTimeouts.toLong(),
                                ),
                        )
                    } else {
                        emptyMap()
                    },
            )
    }

    private class ConnectionRow(
        id: String,
        window: Int,
    ) {
        var sentAttempts = 0
        var retries = 0
        var succeeded = 0
        var failed = 0
        var timeouts = 0
        var orphaned = 0
        var inFlightIntegral = 0.0
        var orphanedIntegral = 0.0
        var backoffIntegral = 0.0
        var poolBusyTimeMs = 0.0
        var poolCapacityTimeMs = 0.0
        var poolQueueIntegralMs = 0.0
        var poolWaitCount = 0
        var poolWaitTimeMs = 0.0
        var poolAcquireTimeouts = 0
        val latency = LatencyAccumulator(sparse = true, context = "connection=$id window=$window response")
    }
}
