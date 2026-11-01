package resiliencelab.core.results

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.catalog.OutputCalculation
import resiliencelab.core.catalog.OutputCalculationKind
import resiliencelab.core.catalog.OutputCalculator
import resiliencelab.core.experiment.LatencySketch
import kotlin.test.Test

class AggregateSeriesTest {
    @Test
    fun `calculator follows catalog operations and rejects invalid divisors`() {
        val context =
            Json.parseToJsonElement(
                """{"value":12,"duration":400,"capacity":3,"retries":4,"latency":{"sumMs":15,"count":2,"p99Ms":9}}""",
            )
        val cases =
            listOf(
                OutputCalculation(OutputCalculationKind.VALUE, "value") to 12.0,
                OutputCalculation(OutputCalculationKind.RATE, "value", "duration") to 30.0,
                OutputCalculation(OutputCalculationKind.RATIO, "value", "capacity") to 4.0,
                OutputCalculation(OutputCalculationKind.RATIO_TO_DIFFERENCE, "value", "retries") to 1.5,
                OutputCalculation(OutputCalculationKind.NORMALIZED_RATIO, "value", "duration", "capacity") to 0.01,
                OutputCalculation(OutputCalculationKind.MEAN, "latency") to 7.5,
                OutputCalculation(OutputCalculationKind.QUANTILE, "latency", percentile = 0.99) to 9.0,
            )
        cases.forEach { (calculation, expected) -> assertThat(OutputCalculator.calculate(calculation, context)).isEqualTo(expected) }
        for (invalid in listOf("0", "-1", "null", "\"3\"", "true", "{}", "[]")) {
            val row = Json.parseToJsonElement("""{"value":1,"divisor":$invalid}""")
            assertThat(OutputCalculator.calculate(OutputCalculation(OutputCalculationKind.RATIO, "value", "divisor"), row)).isNull()
        }
        assertThat(OutputCalculator.calculate(OutputCalculation(OutputCalculationKind.VALUE, "missing.value"), context)).isNull()
        assertThat(
            OutputCalculator.calculate(OutputCalculation(OutputCalculationKind.QUANTILE, "latency", percentile = 0.9), context),
        ).isNull()
    }

    @Test
    fun `aggregate uses independent values with sample deviation and sparse counts`() {
        val calculation = OutputCalculation(OutputCalculationKind.RATIO, "successes", "arrivals")
        val values = listOf("""{"successes":1,"arrivals":2}""", """{"successes":3,"arrivals":4}""", """{"successes":0,"arrivals":0}""")
        val result = AggregateOutputs.calculate(calculation, values.map(Json::parseToJsonElement))
        assertThat(result.mean).isEqualTo(0.625)
        assertThat(result.stdDev).isEqualTo(0.1768)
        assertThat(result.count).isEqualTo(2)
        val complete = AggregateOutputs.calculate(calculation, values.take(2).map(Json::parseToJsonElement))
        assertThat(complete.count).isNull()
    }

    @Test
    fun `empty and single observations have no standard deviation`() {
        val calculation = OutputCalculation(OutputCalculationKind.MEAN, "latency")
        val empty = Json.parseToJsonElement("""{"latency":{"count":0,"sumMs":0}}""")
        val missing = AggregateOutputs.calculate(calculation, listOf(empty, empty))
        assertThat(missing.mean).isNull()
        assertThat(missing.stdDev).isNull()
        assertThat(missing.count).isZero()
        val one =
            AggregateOutputs.calculate(
                calculation,
                listOf(empty, Json.parseToJsonElement("""{"latency":{"count":2,"sumMs":246.9134}}""")),
            )
        assertThat(one.mean).isEqualTo(123.5)
        assertThat(one.stdDev).isNull()
        assertThat(one.count).isEqualTo(1)
    }

    @Test
    fun `pooled quantile matches combined observations rather than mean quantiles`() {
        val calculation = OutputCalculation(OutputCalculationKind.QUANTILE, "latency", percentile = 0.99)

        fun row(
            value: Double,
            weight: Long,
        ) = buildJsonObject {
            val sketch = LatencySketch().also { it.add(value, weight) }
            put(
                "latency",
                buildJsonObject {
                    put("count", weight)
                    put("sumMs", value * weight)
                    put("sketch", kotlinx.serialization.json.JsonArray(sketch.bins().map(::JsonPrimitive)))
                    put("p99Ms", sketch.percentile(0.99)!!)
                },
            )
        }
        val result = AggregateOutputs.calculate(calculation, listOf(row(1.0, 999), row(100.0, 1)))
        val combined =
            LatencySketch().also {
                it.add(1.0, 999)
                it.add(100.0)
            }
        assertThat(result.quantile!!).isCloseTo(combined.percentile(0.99)!!, offset(0.0005))
        assertThat(result.quantile).isLessThan(2.0)
        assertThat(result.min).isEqualTo(1.008)
        assertThat(result.max).isEqualTo(100.8)
        assertThat(result.mean).isNull()
        assertThat(result.stdDev).isNull()
        assertThat(result.count).isNull()
    }
}
