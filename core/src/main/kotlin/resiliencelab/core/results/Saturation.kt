package resiliencelab.core.results

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.Serializable

/**
 * Thresholds of the event-time saturation rule. Queue and utilization conditions use the same closed windows.
 * Backlog must persist for [minimumDurationMs]; overflow needs window starts spanning the same duration.
 * Isolated rejections do not confirm saturation, even in a window longer than the duration threshold.
 */
@Serializable
data class SaturationRule(
    @EncodeDefault val minimumDurationMs: Double = 100.0,
    @EncodeDefault val handlerUtilizationThreshold: Double = 0.95,
    @EncodeDefault val meanQueueLengthThreshold: Double = 0.5,
    @EncodeDefault val queueRejectionsThreshold: Int = 0,
)

/** One saturated node and the start of its first qualifying window. */
@Serializable
data class SaturatedNode(
    val node: String,
    val startMs: Double,
)

/**
 * Degradation path of one replication, ordered by onset, downstream position, then node id for deterministic ties.
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
    /**
     * Reads [windows] chronologically for each node. [callChain] is the graph's topological node order; equal onsets
     * put downstream nodes first, with node id as the fallback for nodes outside that order.
     */
    fun detect(
        replication: Int,
        windows: Sequence<NodeWindow>,
        rule: SaturationRule = SaturationRule(),
        callChain: List<String> = emptyList(),
    ): ReplicationSaturation {
        val positions = callChain.withIndex().associate { it.value to it.index }
        val states = mutableMapOf<String, NodeState>()
        windows.forEach { row -> states.getOrPut(row.id) { NodeState() }.observe(row.metrics, rule) }
        val path =
            states
                .mapNotNull { (node, state) -> state.startMs?.let { SaturatedNode(node, it) } }
                .sortedWith(
                    compareBy<SaturatedNode> { it.startMs }
                        .thenByDescending { positions[it.node] ?: -1 }
                        .thenBy { it.node },
                )
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
        private val backlog = PressureInterval()
        private val overflow = PressureInterval()
        val startMs: Double? get() = listOfNotNull(backlog.startMs, overflow.startMs).minOrNull()

        fun observe(
            metrics: WindowMetrics,
            rule: SaturationRule,
        ) {
            val handlers = metrics.slotPools["handlers"]
            val queued =
                metrics.durationMs > 0 &&
                    handlers != null &&
                    handlers.capacityIntegralMs > 0 &&
                    handlers.busyIntegralMs / handlers.capacityIntegralMs >= rule.handlerUtilizationThreshold &&
                    handlers.queueIntegralMs / metrics.durationMs > rule.meanQueueLengthThreshold
            backlog.observe(metrics, rule, queued, metrics.startMs + metrics.durationMs)
            // A rejection count does not establish pressure throughout its window; require later observations.
            overflow.observe(
                metrics,
                rule,
                metrics.durationMs > 0 && (handlers?.queueFullCount ?: 0L) > rule.queueRejectionsThreshold,
                metrics.startMs,
            )
        }
    }

    private class PressureInterval {
        private var streakStartMs: Double? = null
        private var previousEndMs: Double? = null
        var startMs: Double? = null
            private set

        fun observe(
            metrics: WindowMetrics,
            rule: SaturationRule,
            qualifies: Boolean,
            confirmedUntilMs: Double,
        ) {
            if (startMs != null) return
            if (!qualifies) {
                streakStartMs = null
                previousEndMs = null
                return
            }
            val endMs = metrics.startMs + metrics.durationMs
            // Allow only binary64 rounding at adjacent boundaries and the minimum-duration comparison.
            val toleranceMs = 4 * Math.ulp(maxOf(endMs, rule.minimumDurationMs))
            if (previousEndMs == null || kotlin.math.abs(metrics.startMs - requireNotNull(previousEndMs)) > toleranceMs) {
                streakStartMs = metrics.startMs
            }
            previousEndMs = endMs
            if (confirmedUntilMs - requireNotNull(streakStartMs) + toleranceMs >= rule.minimumDurationMs) startMs = streakStartMs
        }
    }
}
