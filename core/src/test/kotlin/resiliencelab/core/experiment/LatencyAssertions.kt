package resiliencelab.core.experiment

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset

/** Timing tests retain exact event-order sums and counts, plus the complete canonical bin population. */
fun assertLatencies(
    actual: LatencyStatistics,
    vararg expected: Double,
) {
    assertThat(actual.count).isEqualTo(expected.size.toLong())
    assertThat(actual.sumMs).isCloseTo(expected.sum(), offset(1e-9))
    assertThat(actual.sketch).isEqualTo(latencyStatistics(expected.toList()).sketch)
}

fun latencyStatistics(values: List<Double>): LatencyStatistics = LatencyAccumulator().apply { values.forEach { add(it) } }.snapshot()
