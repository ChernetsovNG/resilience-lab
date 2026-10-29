package resiliencelab.core.engine.ksl

import resiliencelab.core.experiment.LatencyAccumulator
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
    private val onWindow: (Int, List<NodeWindow>, List<ConnectionWindow>) -> Unit,
) {
    private val totalWindows = windowCount(endMs, windowMs)
    private var index = 0
    private var startMs = 0.0
    private var lastEventMs = 0.0
    private val nodes =
        (services.map { it.path to State(it.path, it.handlers) } + (clientId to State(clientId, 0))).toMap().toSortedMap()
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
            nodes.values.forEach { it.integrate(boundary) }
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
    ) {
        var row = Row(id, 0)
        var queue = 0
        var busy = 0
        private var lastMs = 0.0

        fun integrate(timeMs: Double) {
            val duration = timeMs - lastMs
            row.busyTime += busy * duration
            row.queueIntegral += queue * duration
            lastMs = timeMs
        }

        fun snapshot(duration: Double): WindowMetrics =
            WindowMetrics(
                startMs,
                duration,
                row.originalArrivals,
                row.offeredAttempts,
                row.admittedAttempts,
                row.queueRejections,
                row.successes,
                row.failures,
                row.timeouts,
                row.retries,
                row.busyTime,
                handlers,
                row.queueIntegral,
                row.latency.snapshot(),
            )
    }

    private class Row(
        node: String,
        window: Int,
    ) {
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
        private var inFlight = 0
        private var orphaned = 0
        private var backoff = 0
        private var lastMs = 0.0

        fun integrate(timeMs: Double) {
            val duration = timeMs - lastMs
            row.inFlightIntegral += inFlight * duration
            row.orphanedIntegral += orphaned * duration
            row.backoffIntegral += backoff * duration
            lastMs = timeMs
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
        val latency = LatencyAccumulator(sparse = true, context = "connection=$id window=$window response")
    }
}
