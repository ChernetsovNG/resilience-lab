package resiliencelab.core.experiment

import com.datadoghq.sketch.ddsketch.DDSketch
import com.datadoghq.sketch.ddsketch.mapping.BitwiseLinearlyInterpolatedMapping
import com.datadoghq.sketch.ddsketch.store.SparseStore
import com.datadoghq.sketch.ddsketch.store.UnboundedSizeDenseStore
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlin.math.floor

/**
 * S5's `ddsketch-bitwise6-rational-v1`, in milliseconds. Counts are exact integers; bin representatives have
 * relative error at most 1/128 (apart from binary64 rounding). KSL's p*(n+1) interpolation is retained.
 * All value, count and occupied-span checks precede mutation. No collapsing or automatic precision changes.
 */
class LatencySketch(
    sparse: Boolean = false,
    private val context: String = "latency",
) {
    private val sketch = DDSketch(Mapping) { if (sparse) SparseStore() else UnboundedSizeDenseStore() }
    var count: Long = 0
        private set
    private var low = Int.MAX_VALUE
    private var high = Int.MIN_VALUE

    fun add(
        valueMs: Double,
        weight: Long = 1,
    ) {
        require(valueMs.isFinite() && (valueMs == 0.0 || valueMs >= MIN_VALUE && valueMs < MAX_VALUE)) {
            "$context: value must be zero or in [2^-1021, 2^1023) ms"
        }
        val index = if (valueMs == 0.0) null else Mapping.index(valueMs)
        val nextLow = if (index == null) low else minOf(low, index)
        val nextHigh = if (index == null) high else maxOf(high, index)
        checkLimits(weight, nextLow, nextHigh)
        sketch.accept(valueMs, weight.toDouble())
        count += weight
        low = nextLow
        high = nextHigh
    }

    /** Merges fixed-profile millisecond sketches; a rejected merge leaves the receiver unchanged. */
    fun merge(other: LatencySketch) {
        if (other.count == 0L) return
        val nextLow = minOf(low, other.low)
        val nextHigh = maxOf(high, other.high)
        checkLimits(other.count, nextLow, nextHigh)
        sketch.mergeWith(other.sketch)
        count += other.count
        low = nextLow
        high = nextHigh
    }

    /** Canonical payload: zeroCount, then strictly ascending (index, count) pairs; empty is [0]. */
    fun bins(): List<Long> {
        val positive = sortedMapOf<Int, Long>()
        sketch.positiveValueStore.forEach { index, n -> if (n > 0.0) positive[index] = n.toLong() }
        return buildList {
            add(count - positive.values.sum())
            positive.forEach { (index, n) ->
                add(index.toLong())
                add(n)
            }
        }
    }

    /** Empty distributions return null. Extreme ranks use the first/last bin representative (zero stays exact). */
    fun percentile(probability: Double): Double? {
        require(probability.isFinite() && probability > 0.0 && probability < 1.0) { "Probability must be in (0, 1)" }
        if (count == 0L) return null
        val payload = bins()

        fun atRank(rank: Long): Double {
            var cumulative = payload[0]
            if (rank < cumulative) return 0.0
            for (i in 1 until payload.size step 2) {
                cumulative += payload[i + 1]
                if (rank < cumulative) return Mapping.value(payload[i].toInt())
            }
            error("Missing rank $rank")
        }
        val position = probability * (count + 1).toDouble()
        if (position < 1.0) return atRank(0)
        if (position >= count.toDouble()) return atRank(count - 1)
        val lower = floor(position).toLong()
        val a = atRank(lower - 1)
        val b = atRank(lower)
        return a + (position - lower) * (b - a)
    }

    private fun checkLimits(
        added: Long,
        nextLow: Int,
        nextHigh: Int,
    ) {
        require(added > 0 && added <= MAX_COUNT - count) { "$context: count limit $MAX_COUNT" }
        require(nextLow > nextHigh || nextHigh.toLong() - nextLow + 1 <= MAX_SPAN) {
            "$context: occupied bin span limit $MAX_SPAN"
        }
    }

    private object Mapping : BitwiseLinearlyInterpolatedMapping(6) {
        override fun value(index: Int): Double = lowerBound(index) * (129.0 / 128.0)

        override fun relativeAccuracy(): Double = 1.0 / 128.0
    }

    companion object {
        const val PROFILE = "ddsketch-bitwise6-rational-v1"
        const val LIBRARY_VERSION = "0.8.3"
        const val MAX_COUNT = 9_007_199_254_740_990L
        const val MAX_SPAN = 2048
        private val MIN_VALUE = Math.scalb(1.0, -1021)
        private val MAX_VALUE = Math.scalb(1.0, 1023)

        /** Validates the wire profile, unit, ordered integer bins and limits before exposing a decoded sketch. */
        fun fromBins(
            bins: List<Long>,
            profile: String = PROFILE,
            unit: String = "ms",
            context: String = "latency",
        ): LatencySketch {
            require(profile == PROFILE && unit == "ms") { "$context: incompatible profile or unit" }
            require(bins.isNotEmpty() && bins.size % 2 == 1 && bins[0] in 0..MAX_COUNT) { "$context: invalid bins" }
            val result = LatencySketch(context = context)
            if (bins[0] > 0) result.add(0.0, bins[0])
            var previous = Long.MIN_VALUE
            for (i in 1 until bins.size step 2) {
                val index = bins[i]
                require(index in -65_344..65_471 && index > previous) { "$context: bin index range or order" }
                result.add(Mapping.value(index.toInt()), bins[i + 1])
                previous = index
            }
            return result
        }
    }
}

/** Sufficient latency statistics: event-order sum for the exact mean and fixed-profile bins for quantiles. */
@Serializable
@OptIn(ExperimentalSerializationApi::class)
data class LatencyStatistics(
    @EncodeDefault val count: Long = 0,
    @EncodeDefault val sumMs: Double = 0.0,
    @EncodeDefault val sketch: List<Long> = listOf(0),
)

/** Bounded-memory accumulation; rejected observations do not change the sum or the sketch. */
class LatencyAccumulator(
    sparse: Boolean = false,
    private val context: String = "latency",
) {
    private val sketch = LatencySketch(sparse, context)
    private var sumMs = 0.0

    fun add(valueMs: Double) {
        val nextSum = sumMs + valueMs
        require(nextSum.isFinite()) { "$context: latency sum limit" }
        sketch.add(valueMs)
        sumMs = nextSum
    }

    fun merge(statistics: LatencyStatistics) {
        val other = LatencySketch.fromBins(statistics.sketch, context = context)
        require(other.count == statistics.count && statistics.sumMs.isFinite() && statistics.sumMs >= 0.0) {
            "$context: invalid latency statistics"
        }
        val nextSum = sumMs + statistics.sumMs
        require(nextSum.isFinite()) { "$context: latency sum limit" }
        sketch.merge(other)
        sumMs = nextSum
    }

    fun snapshot(): LatencyStatistics = LatencyStatistics(sketch.count, sumMs, sketch.bins())
}
