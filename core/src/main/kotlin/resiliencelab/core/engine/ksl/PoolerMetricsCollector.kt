package resiliencelab.core.engine.ksl

import resiliencelab.core.experiment.LatencyAccumulator
import resiliencelab.core.experiment.PoolerMetrics
import resiliencelab.core.experiment.TimeWeightedSeries
import resiliencelab.core.ir.ServiceNode

/** Pooler cohort counters and measurement-only resource integrals; no simulation events are scheduled here. */
internal class PoolerMetricsCollector(
    private val node: ServiceNode,
    private val startMs: Double,
    private val endMs: Double,
) {
    val clientSlots = SlotStatistics(startMs, endMs, node.handlers)
    val serverSlots = SlotStatistics(startMs, endMs, requireNotNull(node.pooler).poolSize)
    var offered = 0
    var admitted = 0
    var clientRejections = 0
    private var successes = 0
    private var failures = 0
    val clients = TimeWeightedSeries(startMs, endMs)
    val servers = TimeWeightedSeries(startMs, endMs)
    val queue = TimeWeightedSeries(startMs, endMs)
    private val latency = LatencyAccumulator(context = "pooler=${node.path} cohort residence")

    fun waitCompleted(acquisition: SlotAcquisition) {
        serverSlots.completed(acquisition)
    }

    fun complete(
        residenceMs: Double,
        succeeded: Boolean,
    ) {
        if (succeeded) successes++ else failures++
        latency.add(residenceMs)
    }

    fun finish(timeMs: Double) {
        clientSlots.finish(timeMs)
        serverSlots.finish(timeMs)
        clients.finish(timeMs)
        servers.finish(timeMs)
        queue.finish(timeMs)
    }

    fun snapshot(): PoolerMetrics =
        PoolerMetrics(
            offeredAttempts = offered,
            admittedAttempts = admitted,
            successes = successes,
            failures = failures,
            measurementMs = endMs - startMs,
            latency = latency.snapshot(),
            slotPools =
                mapOf(
                    "clientConnections" to clientSlots.snapshot(clients.integral, 0.0).copy(queueFullCount = clientRejections.toLong()),
                    "serverConnections" to serverSlots.snapshot(servers.integral, queue.integral),
                ),
        )
}
