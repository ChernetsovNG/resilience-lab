package resiliencelab.core.ir

/** A point of the client profile; time is measured from simulation start, including warm-up. */
data class LoadPoint(
    val timeMs: Double,
    val ratePerMs: Double,
)

/**
 * Piecewise-linear arrival intensity. Outside the points the nearest value is held.
 * The compiler validates strictly increasing times and non-negative intensity at every point.
 */
data class LoadProfile(
    val points: List<LoadPoint>,
) {
    init {
        require(points.isNotEmpty()) { "A load profile needs at least one point" }
    }

    /** Constant profiles preserve the original exponential arrival stream without thinning draws. */
    val isConstant: Boolean get() = points.all { it.ratePerMs == points.first().ratePerMs }

    /** Intensity at simulation time [timeMs], in requests per millisecond. */
    fun rateAt(timeMs: Double): Double {
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

    /** Maximum intensity on the arrival interval, including a partial final segment. */
    fun maximum(untilMs: Double): Double = if (isConstant) points.first().ratePerMs else boundaries(untilMs).maxOf(::rateAt)

    /** Exact trapezoidal integral divided by the arrival interval length. */
    fun average(untilMs: Double): Double {
        if (isConstant) return points.first().ratePerMs
        return boundaries(untilMs).zipWithNext().sumOf { (from, to) ->
            (rateAt(from) / 2 + rateAt(to) / 2) * ((to - from) / untilMs)
        }
    }

    private fun boundaries(untilMs: Double): List<Double> =
        listOf(0.0) + points.map { it.timeMs }.filter { it > 0.0 && it < untilMs } + untilMs

    companion object {
        fun constant(ratePerMs: Double): LoadProfile = LoadProfile(listOf(LoadPoint(0.0, ratePerMs)))
    }
}
