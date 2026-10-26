package resiliencelab.core.experiment

import kotlin.test.Test
import kotlin.test.assertEquals

class TimeWeightedSeriesTest {
    @Test
    fun `average integrates only the measurement interval and excludes runout`() {
        val series = TimeWeightedSeries(measurementStartMs = 5.0, measurementEndMs = 15.0)

        series.record(timeMs = 0.0, value = 100.0)
        series.record(timeMs = 5.0, value = 2.0)
        series.record(timeMs = 10.0, value = 6.0)
        series.record(timeMs = 20.0, value = 1_000.0)
        series.finish(timeMs = 30.0)

        assertEquals(4.0, series.average, 1e-12)
    }

    @Test
    fun `initial state is included and zero duration changes have no weight`() {
        val series = TimeWeightedSeries(measurementStartMs = 5.0, measurementEndMs = 15.0)

        series.record(timeMs = 5.0, value = 3.0)
        series.record(timeMs = 7.0, value = 9.0)
        series.record(timeMs = 7.0, value = 4.0)
        series.finish(timeMs = 25.0)

        assertEquals(3.8, series.average, 1e-12)
        assertEquals(4.0, series.p95, 1e-12)
    }

    @Test
    fun `p95 uses duration rather than the number of changes`() {
        val series = TimeWeightedSeries(measurementStartMs = 0.0, measurementEndMs = 10.0)

        series.record(timeMs = 0.0, value = 0.0)
        series.record(timeMs = 9.0, value = 1.0)
        series.record(timeMs = 9.5, value = 100.0)
        series.finish(timeMs = 10.0)

        assertEquals(5.05, series.average, 1e-12)
        assertEquals(1.0, series.p95, 1e-12)
    }
}
