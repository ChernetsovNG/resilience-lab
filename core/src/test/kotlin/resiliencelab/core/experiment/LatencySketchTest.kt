package resiliencelab.core.experiment

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.assertj.core.data.Offset.offset
import kotlin.test.Test

class LatencySketchTest {
    @Test
    fun `retains KSL ranks and interpolation within the profile accuracy`() {
        val sketch = LatencySketch()
        repeat(19) { sketch.add(1.0) }
        sketch.add(1000.0)
        assertThat(sketch.percentile(0.95)!!).isCloseTo(950.05, offset(950.05 / 128 + 1e-10))
        assertThat(sketch.percentile(0.95)!!).isGreaterThan(900.0)
        assertThat(sketch.percentile(0.99)!!).isCloseTo(1000.0, offset(1000.0 / 128))
        assertThat(LatencySketch().percentile(0.95)).isNull()
        val zero = LatencySketch().apply { add(0.0) }
        assertThat(zero.percentile(0.99)).isEqualTo(0.0)
        assertThat(zero.bins()).containsExactly(1L)
    }

    @Test
    fun `rejected values and future count or span leave bins unchanged`() {
        val sketch = LatencySketch(context = "node=service-a window=2").apply { add(1.0) }
        val before = sketch.bins()
        listOf(-1.0, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.MIN_VALUE).forEach { value ->
            assertThatThrownBy { sketch.add(value) }.hasMessageContaining("node=service-a window=2")
            assertThat(sketch.bins()).isEqualTo(before)
        }
        assertThatThrownBy { sketch.add(Math.scalb(1.0, 40)) }.hasMessageContaining("2048")
        assertThat(sketch.bins()).isEqualTo(before)
        val full = LatencySketch().apply { add(1.0, LatencySketch.MAX_COUNT) }
        val fullBefore = full.bins()
        assertThatThrownBy { full.add(0.0) }.hasMessageContaining("count")
        assertThat(full.bins()).isEqualTo(fullBefore)
    }

    @Test
    fun `sparse and dense merges have canonical integer bins in every order`() {
        val observations = List(3000) { if (it % 31 == 0) 0.0 else Math.scalb(1.0 + (it % 64) / 64.0, it % 20 - 10) }
        val direct = LatencySketch().apply { observations.forEach { add(it) } }
        val pieces = observations.chunked(37).map { values -> LatencySketch(sparse = true).apply { values.forEach { add(it) } } }
        val forward = LatencySketch().apply { pieces.forEach { merge(it) } }
        val reverse = LatencySketch().apply { pieces.reversed().forEach { merge(it) } }
        assertThat(forward.bins()).isEqualTo(direct.bins()).isEqualTo(reverse.bins())
        assertThat(LatencySketch.fromBins(direct.bins()).bins()).isEqualTo(direct.bins())
        assertThat(forward.percentile(0.99)).isEqualTo(reverse.percentile(0.99))
        val before = forward.bins()
        assertThatThrownBy { forward.merge(LatencySketch().apply { add(Math.scalb(1.0, 40)) }) }
            .hasMessageContaining("2048")
        assertThat(forward.bins()).isEqualTo(before)
        assertThatThrownBy { LatencySketch.fromBins(listOf(0, 2, 1, 1, 1)) }.hasMessageContaining("order")
        assertThatThrownBy { LatencySketch.fromBins(listOf(0), profile = "other") }.hasMessageContaining("profile")
    }
}
