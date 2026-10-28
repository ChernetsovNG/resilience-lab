package resiliencelab.research.latency

import com.datadoghq.sketch.ddsketch.DDSketch
import com.datadoghq.sketch.ddsketch.mapping.BitwiseLinearlyInterpolatedMapping
import com.datadoghq.sketch.ddsketch.mapping.IndexMapping
import com.datadoghq.sketch.ddsketch.mapping.LogarithmicMapping
import com.datadoghq.sketch.ddsketch.store.UnboundedSizeDenseStore
import com.datadoghq.sketch.ddsketch.store.SparseStore
import java.util.TreeMap
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln

const val PROFILE = "ddsketch-bitwise6-rational-v1"
const val MAX_COUNT = 9007199254740990L
const val MAX_SPAN = 2048
val MIN_POSITIVE: Double = Math.scalb(1.0, -1021)
val MAX_EXCLUSIVE: Double = Math.scalb(1.0, 1023)

/** Fixed dyadic representative avoids Math.exp differences between JVMs and JavaScript. */
object PortableMapping : BitwiseLinearlyInterpolatedMapping(6) {
    override fun value(index: Int): Double = lowerBound(index) * (129.0 / 128.0)
    override fun relativeAccuracy(): Double = 1.0 / 128.0
}

/** Canonical wire payload: zero count followed by ascending (index, integer count) pairs. */
data class Bins(val zero: Long, val positive: Map<Int, Long>) {
    val count: Long get() = zero + positive.values.sum()
    fun array(): List<Long> = listOf(zero) + positive.toSortedMap().flatMap { (i, n) -> listOf(i.toLong(), n) }
    fun json(): String = array().joinToString(",", "[", "]")

    fun atRank(rank: Long, value: (Int) -> Double): Double {
        require(rank in 0 until count)
        if (rank < zero) return 0.0
        var cumulative = zero
        for ((index, n) in positive.toSortedMap()) {
            cumulative += n
            if (rank < cumulative) return value(index)
        }
        error("Missing rank")
    }

    /** KSL R1.8.1 percentile convention, retaining its exact interpolation expression. */
    fun percentile(p: Double, value: (Int) -> Double = PortableMapping::value): Double? {
        require(p.isFinite() && p > 0.0 && p < 1.0)
        if (count == 0L) return null
        val pos = p * (count + 1).toDouble()
        if (pos < 1.0) return atRank(0, value)
        if (pos >= count.toDouble()) return atRank(count - 1, value)
        val lower = floor(pos).toLong()
        val a = atRank(lower - 1, value)
        val b = atRank(lower, value)
        return a + (pos - lower) * (b - a)
    }
}

interface Collector {
    fun add(value: Double, weight: Long = 1)
    fun bins(): Bins
    fun representative(index: Int): Double
}

/** Guarded library collector; rejected add/merge operations leave the sketch unchanged. */
class LibrarySketch(val mapping: IndexMapping = PortableMapping, sparse: Boolean = false) : Collector {
    private val sketch = DDSketch(mapping) { if (sparse) SparseStore() else UnboundedSizeDenseStore() }
    private var count = 0L
    private var low = Int.MAX_VALUE
    private var high = Int.MIN_VALUE

    override fun add(value: Double, weight: Long) {
        validateValue(value)
        require(weight > 0 && weight <= MAX_COUNT - count) { "COUNT_LIMIT" }
        val index = if (value == 0.0) null else mapping.index(value)
        val nextLow = if (index == null) low else minOf(low, index)
        val nextHigh = if (index == null) high else maxOf(high, index)
        require(nextLow > nextHigh || nextHigh.toLong() - nextLow + 1 <= MAX_SPAN) { "BIN_SPAN_LIMIT" }
        sketch.accept(value, weight.toDouble())
        count += weight
        low = nextLow
        high = nextHigh
    }

    fun merge(other: LibrarySketch) {
        require(mapping == other.mapping) { "PROFILE_MISMATCH" }
        require(other.count <= MAX_COUNT - count) { "COUNT_LIMIT" }
        val nextLow = minOf(low, other.low)
        val nextHigh = maxOf(high, other.high)
        require(nextLow > nextHigh || nextHigh.toLong() - nextLow + 1 <= MAX_SPAN) { "BIN_SPAN_LIMIT" }
        sketch.mergeWith(other.sketch)
        count += other.count
        low = nextLow
        high = nextHigh
    }

    override fun bins(): Bins {
        val bins = sortedMapOf<Int, Long>()
        sketch.positiveValueStore.forEach { index, n -> if (n > 0) bins[index] = n.toLong() }
        val positiveCount = bins.values.sum()
        return Bins(count - positiveCount, bins)
    }

    override fun representative(index: Int): Double = mapping.value(index)
    fun libraryPercentile(p: Double): Double = sketch.getValueAtQuantile(p)
}

/** Independent logarithmic DDSketch baseline; deliberately simple sparse TreeMap store. */
class KotlinLogSketch : Collector {
    private val positive = TreeMap<Int, Long>()
    private var zero = 0L
    private var count = 0L
    private val logGamma = ln(1.01 / 0.99)

    override fun add(value: Double, weight: Long) {
        validateValue(value)
        require(weight > 0 && weight <= MAX_COUNT - count) { "COUNT_LIMIT" }
        if (value == 0.0) {
            zero += weight
        } else {
            val index = floor(ln(value) / logGamma).toInt()
            val low = minOf(index, positive.firstKeyOrNull() ?: index)
            val high = maxOf(index, positive.lastKeyOrNull() ?: index)
            require(high.toLong() - low + 1 <= MAX_SPAN) { "BIN_SPAN_LIMIT" }
            positive[index] = (positive[index] ?: 0L) + weight
        }
        count += weight
    }

    override fun bins(): Bins = Bins(zero, positive.toMap())
    override fun representative(index: Int): Double = exp(index * logGamma) * 1.01
    private fun TreeMap<Int, Long>.firstKeyOrNull(): Int? = if (isEmpty()) null else firstKey()
    private fun TreeMap<Int, Long>.lastKeyOrNull(): Int? = if (isEmpty()) null else lastKey()
}

fun validateValue(value: Double) {
    require(value.isFinite() && value >= 0.0) { "INVALID_LATENCY" }
    require(value == 0.0 || (value >= MIN_POSITIVE && value < MAX_EXCLUSIVE)) { "LATENCY_RANGE" }
}

val factories: Map<String, () -> Collector> = linkedMapOf(
    "java-portable" to { LibrarySketch() },
    "java-portable-sparse" to { LibrarySketch(sparse = true) },
    "java-log" to { LibrarySketch(LogarithmicMapping(0.01)) },
    "kotlin-log" to { KotlinLogSketch() },
)
