package resiliencelab.core.results

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.Serializable

/** Thresholds of the event-time saturation rule. Queue and utilization conditions use the same closed windows. */
@Serializable
data class SaturationRule(
    @EncodeDefault val consecutiveWindows: Int = 3,
    @EncodeDefault val handlerUtilizationThreshold: Double = 0.95,
    @EncodeDefault val meanQueueLengthThreshold: Double = 0.0,
)

/** One saturated node and the start of its first qualifying window. */
@Serializable
data class SaturatedNode(
    val node: String,
    val startMs: Double,
)

/**
 * Degradation path of one replication, ordered by onset and then node id for deterministic ties.
 * An empty path explicitly means that no node saturated.
 */
@Serializable
data class ReplicationSaturation(
    val replication: Int,
    val degradationPath: List<SaturatedNode>,
)

/** Replication count and onset distribution for replications that named [node] first. Min/max describe the spread. */
@Serializable
data class FirstNodeSaturation(
    val node: String,
    val replicationCount: Int,
    val medianStartMs: Double,
    val minStartMs: Double,
    val maxStartMs: Double,
)

/**
 * Saturation insight for one variant point. [firstNodes] sorts by descending count then node id; [replications]
 * sorts by replication number. Empty paths are counted only in [withoutSaturation], never in onset statistics.
 */
@Serializable
data class SaturationSummary(
    val rule: SaturationRule,
    val withoutSaturation: Int,
    val firstNodes: List<FirstNodeSaturation>,
    val replications: List<ReplicationSaturation>,
)

/** Applies the stage 1 saturation rule and aggregates independent replications without hiding empty paths. */
object SaturationAnalyzer {
    fun detect(
        replication: Int,
        windows: Sequence<NodeWindow>,
        rule: SaturationRule = SaturationRule(),
    ): ReplicationSaturation {
        val states = mutableMapOf<String, NodeState>()
        windows.forEach { row -> states.getOrPut(row.id) { NodeState() }.observe(row.metrics, rule) }
        val path =
            states
                .mapNotNull { (node, state) -> state.startMs?.let { SaturatedNode(node, it) } }
                .sortedWith(compareBy<SaturatedNode> { it.startMs }.thenBy { it.node })
        return ReplicationSaturation(replication, path)
    }

    fun aggregate(
        replications: List<ReplicationSaturation>,
        rule: SaturationRule = SaturationRule(),
    ): SaturationSummary {
        val ordered = replications.sortedBy { it.replication }
        val firstNodes =
            ordered
                .mapNotNull { it.degradationPath.firstOrNull() }
                .groupBy { it.node }
                .map { (node, occurrences) ->
                    val times = occurrences.map { it.startMs }.sorted()
                    FirstNodeSaturation(
                        node,
                        occurrences.size,
                        median(times),
                        times.first(),
                        times.last(),
                    )
                }.sortedWith(compareByDescending<FirstNodeSaturation> { it.replicationCount }.thenBy { it.node })
        return SaturationSummary(
            rule,
            ordered.count { it.degradationPath.isEmpty() },
            firstNodes,
            ordered,
        )
    }

    private fun median(sorted: List<Double>): Double {
        val middle = sorted.size / 2
        return if (sorted.size % 2 == 0) (sorted[middle - 1] + sorted[middle]) / 2 else sorted[middle]
    }

    private class NodeState {
        private var consecutive = 0
        private var streakStartMs = 0.0
        private var streakSaturationMs: Double? = null
        private var rejectionStartMs: Double? = null
        val startMs: Double? get() = listOfNotNull(streakSaturationMs, rejectionStartMs).minOrNull()

        fun observe(
            metrics: WindowMetrics,
            rule: SaturationRule,
        ) {
            if (streakSaturationMs == null) {
                val hot =
                    metrics.handlers > 0 &&
                        metrics.durationMs > 0 &&
                        metrics.busyHandlerTimeMs / (metrics.handlers * metrics.durationMs) >=
                        rule.handlerUtilizationThreshold &&
                        metrics.queueLengthIntegralMs / metrics.durationMs > rule.meanQueueLengthThreshold
                if (hot) {
                    if (consecutive == 0) streakStartMs = metrics.startMs
                    consecutive++
                    if (consecutive == rule.consecutiveWindows) streakSaturationMs = streakStartMs
                } else {
                    consecutive = 0
                }
            }
            if (rejectionStartMs == null && metrics.queueRejections > 0) rejectionStartMs = metrics.startMs
        }
    }
}
