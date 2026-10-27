package resiliencelab.core.catalog

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class QuantitiesTest {
    @Test
    fun `parses durations into milliseconds`() {
        assertThat(Quantities.parse("250ms", Dimension.DURATION)).isEqualTo(250.0)
        assertThat(Quantities.parse("2s", Dimension.DURATION)).isEqualTo(2_000.0)
        assertThat(Quantities.parse("1.5min", Dimension.DURATION)).isEqualTo(90_000.0)
        assertThat(Quantities.parse("0.5ms", Dimension.DURATION)).isEqualTo(0.5)
    }

    @Test
    fun `parses rates into requests per millisecond`() {
        assertThat(Quantities.parse("120/s", Dimension.RATE)).isEqualTo(0.12)
        assertThat(Quantities.parse("3/ms", Dimension.RATE)).isEqualTo(3.0)
        assertThat(Quantities.parse("60/min", Dimension.RATE)).isEqualTo(0.001)
    }

    @Test
    fun `parses percentages into probabilities`() {
        assertThat(Quantities.parse("0.5%", Dimension.PROBABILITY)).isEqualTo(0.005)
        assertThat(Quantities.parse("100%", Dimension.PROBABILITY)).isEqualTo(1.0)
    }

    @Test
    fun `rejects malformed, unitless, foreign-unit and non-finite quantities`() {
        listOf("120", "-1ms", "1 ms", " 1ms", "ms", "1h", "1e999ms", "1.ms").forEach { text ->
            assertThat(Quantities.parse(text, Dimension.DURATION)).describedAs(text).isNull()
        }
        assertThat(Quantities.parse("120/s", Dimension.DURATION)).isNull()
        assertThat(Quantities.parse("5ms", Dimension.PROBABILITY)).isNull()
    }

    @Test
    fun `formats canonical values with base display units`() {
        assertThat(Quantities.format(1_000.0, Dimension.DURATION)).isEqualTo("1000ms")
        assertThat(Quantities.format(0.5, Dimension.DURATION)).isEqualTo("0.5ms")
        assertThat(Quantities.format(0.12, Dimension.RATE)).isEqualTo("120/s")
        assertThat(Quantities.format(0.005, Dimension.PROBABILITY)).isEqualTo("0.5%")
    }

    @Test
    fun `lists accepted units per dimension with their scales`() {
        assertThat(Quantities.unitsOf(Dimension.DURATION).map { it.symbol }).containsExactly("ms", "s", "min")
        assertThat(Quantities.unitsOf(Dimension.RATE).map { it.symbol }).containsExactly("/ms", "/s", "/min")
        assertThat(Quantities.unitsOf(Dimension.RATE)[1]).isEqualTo(QuantityUnit("/s", 1.0, 1_000.0))
        assertThat(Quantities.unitsOf(Dimension.PROBABILITY)).containsExactly(QuantityUnit("%", 1.0, 100.0))
    }
}
