package resiliencelab.core.results

import kotlinx.serialization.Serializable
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.SlotPoolMetrics

/** One pooled measurement maximum; [label] names both the element and its slot set. */
@Serializable
data class SlotPoolPeak(
    val node: String,
    val slotPool: String,
    val value: Double,
    val label: SlotPoolLabel,
)

/** Independent maxima over instance slot sets. Null means no defined denominator, never an invented zero. */
@Serializable
data class CapacityHeadroom(
    val utilization: SlotPoolPeak? = null,
    val meanQueueLength: SlotPoolPeak? = null,
)

/** Computes pooled ratios once in core; groups do not compete against their own instances. */
object CapacityHeadroomAnalyzer {
    fun analyze(
        aggregate: AggregateMetrics,
        labels: Map<String, Map<String, SlotPoolLabel>> = emptyMap(),
    ): CapacityHeadroom {
        val groups = aggregate.groups.map { it.id }.toSet()

        data class Row(
            val node: String,
            val duration: Double,
            val pools: Map<String, SlotPoolMetrics>,
        )
        val rows =
            aggregate.services.map { (id, metrics) -> Row(id, metrics.totals.measurementMs, metrics.totals.slotPools) } +
                aggregate.connections.map { (id, metrics) -> Row(id, metrics.totals.measurementMs, metrics.totals.slotPools) } +
                aggregate.poolers.map { (id, metrics) -> Row(id, metrics.totals.measurementMs, metrics.totals.slotPools) }
        val utilization = mutableListOf<SlotPoolPeak>()
        val queues = mutableListOf<SlotPoolPeak>()
        rows.filter { it.node !in groups }.forEach { row ->
            row.pools.forEach { (slot, metrics) ->
                val label = labels[row.node]?.get(slot) ?: SlotPoolLabels.label(row.node, slot)
                if (metrics.capacityIntegralMs > 0) {
                    utilization +=
                        SlotPoolPeak(
                            row.node,
                            slot,
                            metrics.busyIntegralMs / metrics.capacityIntegralMs,
                            label,
                        )
                }
                if (row.duration > 0) queues += SlotPoolPeak(row.node, slot, metrics.queueIntegralMs / row.duration, label)
            }
        }
        val order = compareByDescending<SlotPoolPeak> { it.value }.thenBy { it.node }.thenBy { it.slotPool }
        return CapacityHeadroom(utilization.minWithOrNull(order), queues.minWithOrNull(order))
    }
}
