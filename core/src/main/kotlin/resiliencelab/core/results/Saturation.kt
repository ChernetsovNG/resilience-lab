package resiliencelab.core.results

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.Serializable
import resiliencelab.core.experiment.SlotPoolMetrics

/**
 * Thresholds of the event-time saturation rule. Queue and utilization conditions use the same closed windows.
 * Backlog must persist for [minimumDurationMs]; overflow needs window starts spanning the same duration.
 * Isolated rejections do not confirm saturation, even in a window longer than the duration threshold.
 */
@Serializable
data class SaturationRule(
    @EncodeDefault val minimumDurationMs: Double = 100.0,
    @EncodeDefault val utilizationThreshold: Double = 0.95,
    @EncodeDefault val meanQueueLengthThreshold: Double = 0.5,
    @EncodeDefault val rejectionsThreshold: Int = 0,
)

/** One saturated element and slot set, with the start of its first qualifying window. */
@Serializable
data class SaturatedNode(
    val node: String,
    val startMs: Double,
    @EncodeDefault val slotPool: String = "handlers",
    @EncodeDefault val label: SlotPoolLabel = SlotPoolLabels.label(node, slotPool),
)

/**
 * Degradation path of one replication, ordered by onset, downstream position, element id and slot-set name.
 * An empty path explicitly means that no slot set saturated.
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
    @EncodeDefault val slotPool: String = "handlers",
    @EncodeDefault val label: SlotPoolLabel = SlotPoolLabels.label(node, slotPool),
)

/**
 * Saturation insight for one variant point. [firstNodes] sorts by descending count, element id and slot set; [replications]
 * sorts by replication number. Empty paths are counted only in [withoutSaturation], never in onset statistics.
 */
@Serializable
data class SaturationSummary(
    val rule: SaturationRule,
    val withoutSaturation: Int,
    val firstNodes: List<FirstNodeSaturation>,
    val replications: List<ReplicationSaturation>,
)

/** Applies the same sustained-pressure rule to every instance slot set, including connection pools. */
object SaturationAnalyzer {
    /**
     * Reads [windows] chronologically for each element. Connection rows use only window bounds and [WindowMetrics.slotPools].
     * [callChain] places calls between source and target; equal onsets put downstream elements first.
     */
    fun detect(
        replication: Int,
        windows: Sequence<NodeWindow>,
        rule: SaturationRule = SaturationRule(),
        callChain: List<String> = emptyList(),
        labels: Map<String, Map<String, SlotPoolLabel>> = emptyMap(),
        positions: Map<String, Int> = callChain.withIndex().associate { it.value to it.index },
    ): ReplicationSaturation {
        val detector = Detector(rule, labels, positions)
        windows.forEach(detector::observe)
        return detector.result(replication)
    }

    /** Retains two pressure intervals per instance slot set, independently of the number of observed windows. */
    class Detector(
        private val rule: SaturationRule = SaturationRule(),
        private val labels: Map<String, Map<String, SlotPoolLabel>> = emptyMap(),
        private val positions: Map<String, Int> = emptyMap(),
    ) {
        private val states = mutableMapOf<Pair<String, String>, NodeState>()

        /** Observes one instance row; windows of each element must arrive chronologically. */
        fun observe(row: NodeWindow) {
            row.metrics.slotPools.forEach { (slot, pool) ->
                states
                    .getOrPut(row.id to slot) { NodeState() }
                    .observe(row.metrics, pool, slot != "clientConnections", rule)
            }
        }

        /** Returns the current confirmed degradation path in the canonical downstream order. */
        fun result(replication: Int): ReplicationSaturation {
            val path =
                states
                    .mapNotNull { (key, state) ->
                        val (node, slot) = key
                        state.startMs?.let { SaturatedNode(node, it, slot, labels[node]?.get(slot) ?: SlotPoolLabels.label(node, slot)) }
                    }.sortedWith(
                        compareBy<SaturatedNode> { it.startMs }
                            .thenByDescending { positions[it.node] ?: -1 }
                            .thenBy { it.node }
                            .thenBy { it.slotPool },
                    )
            return ReplicationSaturation(replication, path)
        }
    }

    fun aggregate(
        replications: List<ReplicationSaturation>,
        rule: SaturationRule = SaturationRule(),
    ): SaturationSummary {
        val ordered = replications.sortedBy { it.replication }
        val firstNodes =
            ordered
                .mapNotNull { it.degradationPath.firstOrNull() }
                .groupBy { it.node to it.slotPool }
                .map { (key, occurrences) ->
                    val times = occurrences.map { it.startMs }.sorted()
                    FirstNodeSaturation(
                        key.first,
                        occurrences.size,
                        median(times),
                        times.first(),
                        times.last(),
                        key.second,
                        occurrences.first().label,
                    )
                }.sortedWith(compareByDescending<FirstNodeSaturation> { it.replicationCount }.thenBy { it.node }.thenBy { it.slotPool })
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
            pool: SlotPoolMetrics,
            hasQueue: Boolean,
            rule: SaturationRule,
        ) {
            val queued =
                hasQueue &&
                    metrics.durationMs > 0 &&
                    pool.capacityIntegralMs > 0 &&
                    pool.busyIntegralMs / pool.capacityIntegralMs >= rule.utilizationThreshold &&
                    pool.queueIntegralMs / metrics.durationMs > rule.meanQueueLengthThreshold
            backlog.observe(metrics, rule, queued, metrics.startMs + metrics.durationMs)
            // A rejection count does not establish pressure throughout its window; require later observations.
            overflow.observe(
                metrics,
                rule,
                metrics.durationMs > 0 && pool.queueFullCount + pool.waitLimitCount > rule.rejectionsThreshold,
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
