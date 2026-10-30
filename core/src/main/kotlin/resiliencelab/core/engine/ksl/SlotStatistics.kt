package resiliencelab.core.engine.ksl

import resiliencelab.core.experiment.SlotPoolMetrics
import resiliencelab.core.experiment.TimeWeightedSeries

/** Capacity and completed-wait observations; busy/queue integrals retain their existing collection order. */
internal class SlotStatistics(
    private val startMs: Double,
    private val endMs: Double,
    initialCapacity: Int,
) {
    private val capacities = TimeWeightedSeries(startMs, endMs)
    private var capacity = initialCapacity
    var waitCount = 0L
    var totalWaitMs = 0.0
    var queueFullCount = 0L
    var waitLimitCount = 0L

    fun capacity(
        timeMs: Double,
        value: Int,
    ) {
        capacities.record(timeMs, value.toDouble())
        capacity = value
    }

    fun start() = capacities.record(startMs, capacity.toDouble())

    fun finish(timeMs: Double) = capacities.finish(timeMs)

    fun completed(acquisition: SlotAcquisition) {
        when (acquisition.outcome) {
            SlotAcquisitionOutcome.QUEUE_FULL -> queueFullCount++
            SlotAcquisitionOutcome.WAIT_LIMIT -> {
                waitLimitCount++
                waitCount++
                totalWaitMs += acquisition.waitMs
            }
            SlotAcquisitionOutcome.WAITED -> {
                waitCount++
                totalWaitMs += acquisition.waitMs
            }
            SlotAcquisitionOutcome.IMMEDIATE -> Unit
        }
    }

    fun snapshot(
        busyIntegralMs: Double,
        queueIntegralMs: Double,
    ) = SlotPoolMetrics(
        busyIntegralMs,
        queueIntegralMs,
        capacities.integral,
        waitCount,
        totalWaitMs,
        queueFullCount,
        waitLimitCount,
    )
}
