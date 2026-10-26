package resiliencelab.core.experiment

/**
 * Integrates chronological, piecewise-constant observations over a fixed measurement interval.
 * The average uses the full interval as its denominator, and the p95 is weighted by time at each value,
 * not by observation count; recording or finishing at the interval end freezes the series.
 */
class TimeWeightedSeries(
    private val measurementStartMs: Double,
    private val measurementEndMs: Double,
) {
    private var currentValue = 0.0
    private var lastTimeMs = measurementStartMs
    private var weightedArea = 0.0
    private var finished = false
    private val durationsMs = sortedMapOf<Double, Double>()

    init {
        require(measurementEndMs > measurementStartMs) { "Measurement interval must have positive duration" }
    }

    val average: Double
        get() = weightedArea / (measurementEndMs - measurementStartMs)

    val p95: Double
        get() {
            val totalDurationMs = durationsMs.values.sum()
            if (totalDurationMs == 0.0) return 0.0
            val targetMs = 0.95 * totalDurationMs
            var cumulativeMs = 0.0
            for ((value, durationMs) in durationsMs) {
                cumulativeMs += durationMs
                if (cumulativeMs >= targetMs) return value
            }
            return durationsMs.lastKey()
        }

    fun record(
        timeMs: Double,
        value: Double,
    ) {
        if (finished || timeMs < measurementStartMs) return
        integrateTo(minOf(timeMs, measurementEndMs))
        if (timeMs >= measurementEndMs) {
            finished = true
        } else {
            currentValue = value
        }
    }

    fun finish(timeMs: Double) {
        if (finished) return
        integrateTo(minOf(maxOf(timeMs, measurementStartMs), measurementEndMs))
        finished = true
    }

    private fun integrateTo(timeMs: Double) {
        val durationMs = timeMs - lastTimeMs
        require(durationMs >= 0.0) { "Observations must be recorded in chronological order" }
        if (durationMs > 0.0) {
            weightedArea += currentValue * durationMs
            durationsMs[currentValue] = (durationsMs[currentValue] ?: 0.0) + durationMs
        }
        lastTimeMs = timeMs
    }
}
