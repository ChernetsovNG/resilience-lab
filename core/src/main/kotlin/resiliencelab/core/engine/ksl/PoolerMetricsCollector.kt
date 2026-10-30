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
    var offered = 0
    var admitted = 0
    var clientRejections = 0
    private var waitTimeouts = 0
    private var successes = 0
    private var failures = 0
    private var waitCount = 0
    private var waitTime = 0.0
    val clients = TimeWeightedSeries(startMs, endMs)
    val servers = TimeWeightedSeries(startMs, endMs)
    val queue = TimeWeightedSeries(startMs, endMs)
    private val latency = LatencyAccumulator(context = "pooler=${node.path} cohort residence")

    fun waitCompleted(acquisition: SlotAcquisition) {
        if (acquisition.outcome == SlotAcquisitionOutcome.WAIT_LIMIT) waitTimeouts++
        if (acquisition.outcome in setOf(SlotAcquisitionOutcome.WAITED, SlotAcquisitionOutcome.WAIT_LIMIT)) {
            waitCount++
            waitTime += acquisition.waitMs
        }
    }

    fun complete(
        residenceMs: Double,
        succeeded: Boolean,
    ) {
        if (succeeded) successes++ else failures++
        latency.add(residenceMs)
    }

    fun finish(timeMs: Double) {
        clients.finish(timeMs)
        servers.finish(timeMs)
        queue.finish(timeMs)
    }

    fun snapshot(): PoolerMetrics =
        PoolerMetrics(
            offered,
            admitted,
            clientRejections,
            waitTimeouts,
            successes,
            failures,
            node.handlers,
            requireNotNull(node.pooler).poolSize,
            endMs - startMs,
            clients.integral,
            servers.integral,
            queue.integral,
            waitCount,
            waitTime,
            latency.snapshot(),
        )
}
