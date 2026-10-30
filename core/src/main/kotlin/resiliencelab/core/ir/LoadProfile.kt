package resiliencelab.core.ir

import java.math.BigDecimal
import java.math.MathContext
import kotlin.math.PI
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/** A point of the client baseline; time is measured from simulation start, including warm-up. */
data class LoadPoint(
    val timeMs: Double,
    val ratePerMs: Double,
)

/** Additive sinusoid; [phase] is in radians and [amplitudePerMs] is non-negative. */
data class LoadSinusoid(
    val amplitudePerMs: Double,
    val periodMs: Double,
    val phase: Double = 0.0,
)

/**
 * Piecewise-linear arrival intensity plus an optional sinusoid. Outside the points the nearest value is held.
 * The compiler validates increasing, non-negative points and a non-negative sum over the arrival interval.
 */
data class LoadProfile(
    val points: List<LoadPoint>,
    val sinusoid: LoadSinusoid? = null,
) {
    private val normalizedPhase = sinusoid?.let { atan2(sin(it.phase), cos(it.phase)) } ?: 0.0

    init {
        require(points.isNotEmpty()) { "A load profile needs at least one point" }
    }

    /** Constant profiles preserve the original exponential arrival stream without thinning draws. */
    val isConstant: Boolean get() = (sinusoid?.amplitudePerMs ?: 0.0) == 0.0 && points.all { it.ratePerMs == points.first().ratePerMs }

    fun rateAt(timeMs: Double): Double = baselineAt(timeMs) + (sinusoid?.let { it.amplitudePerMs * sin(angle(it, timeMs)) } ?: 0.0)

    fun maximum(untilMs: Double): Double = if (isConstant) points.first().ratePerMs else extrema(untilMs).max()

    fun minimum(untilMs: Double): Double = if (isConstant) points.first().ratePerMs else extrema(untilMs).min()

    /** Exact baseline integral and analytic sinusoid integral, divided by the arrival interval length. */
    fun average(untilMs: Double): Double {
        if (isConstant) return points.first().ratePerMs
        val baseline =
            boundaries(untilMs).zipWithNext().sumOf { (from, to) ->
                (baselineAt(from) / 2 + baselineAt(to) / 2) * ((to - from) / untilMs)
            }
        val wave = sinusoid ?: return baseline
        val cycles = untilMs / wave.periodMs
        val sineMean =
            if (cycles < 1e-4) {
                val half = PI * cycles
                sin(angle(wave, untilMs / 2)) * if (half == 0.0) 1.0 else sin(half) / half
            } else {
                (cos(angle(wave, 0.0)) - cos(angle(wave, untilMs))) / (2 * PI * cycles)
            }
        return baseline + wave.amplitudePerMs * sineMean
    }

    private fun baselineAt(timeMs: Double): Double {
        val index = points.binarySearch { it.timeMs.compareTo(timeMs) }
        if (index >= 0) return points[index].ratePerMs
        val next = -index - 1
        if (next == 0) return points.first().ratePerMs
        if (next == points.size) return points.last().ratePerMs
        val left = points[next - 1]
        val right = points[next]
        val fraction = (timeMs - left.timeMs) / (right.timeMs - left.timeMs)
        return left.ratePerMs * (1 - fraction) + right.ratePerMs * fraction
    }

    private fun boundaries(untilMs: Double): List<Double> =
        listOf(0.0) + points.map { it.timeMs }.filter { it > 0.0 && it < untilMs } + untilMs

    // On each linear segment, extrema occur at endpoints or where slope + A*omega*cos(angle) = 0.
    // Repeated stationary phases differ only by the linear baseline: first and last suffice even for many cycles.
    private fun extrema(untilMs: Double): List<Double> =
        buildList {
            val boundaries = boundaries(untilMs)
            addAll(boundaries.map(::rateAt))
            val wave = sinusoid?.takeIf { it.amplitudePerMs > 0.0 } ?: return@buildList
            boundaries.zipWithNext().forEach { (from, to) ->
                val change = baselineAt(to) - baselineAt(from)
                if (!change.isFinite()) return@forEach
                // Scale before converting to Double: finite inputs can overflow an intermediate slope or product.
                val ratio =
                    BigDecimal
                        .valueOf(-change)
                        .multiply(BigDecimal.valueOf(wave.periodMs))
                        .divide(
                            BigDecimal
                                .valueOf(to - from)
                                .multiply(BigDecimal.valueOf(wave.amplitudePerMs))
                                .multiply(BigDecimal.valueOf(2 * PI)),
                            MathContext.DECIMAL128,
                        ).toDouble()
                if (ratio in -1.0..1.0) {
                    val root = acos(ratio)
                    listOf(root, 2 * PI - root).forEach { phase ->
                        val offset = modulo((phase - normalizedPhase) / (2 * PI), 1.0) * wave.periodMs
                        val first = from + modulo(offset - from % wave.periodMs, wave.periodMs)
                        val last = to - modulo(to % wave.periodMs - offset, wave.periodMs)
                        if (first in from..to) add(rateAt(first))
                        if (last in from..to) add(rateAt(last))
                    }
                }
            }
        }

    private fun angle(
        wave: LoadSinusoid,
        timeMs: Double,
    ): Double = (timeMs % wave.periodMs) / wave.periodMs * (2 * PI) + normalizedPhase

    private fun modulo(
        value: Double,
        period: Double,
    ): Double {
        val remainder = value % period
        return if (remainder < 0.0) remainder + period else remainder
    }

    companion object {
        fun constant(ratePerMs: Double): LoadProfile = LoadProfile(listOf(LoadPoint(0.0, ratePerMs)))
    }
}
