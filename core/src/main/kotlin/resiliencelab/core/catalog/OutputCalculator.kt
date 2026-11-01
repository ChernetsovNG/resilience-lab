package resiliencelab.core.catalog

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Closed catalog calculations over the same decoded numeric contexts as web's `calculateOutput` (ADR 0011). */
object OutputCalculator {
    /** Missing fields, nonnumeric values, invalid divisors and nonfinite results have no value. */
    fun calculate(
        calculation: OutputCalculation,
        context: JsonElement,
    ): Double? {
        val raw = field(context, calculation.field)
        val value = number(raw)
        val divisor = number(field(context, calculation.divisor))
        return when (calculation.kind) {
            OutputCalculationKind.VALUE -> value
            OutputCalculationKind.RATE -> divide(value?.times(1000), divisor)
            OutputCalculationKind.RATIO -> divide(value, divisor)
            OutputCalculationKind.RATIO_TO_DIFFERENCE ->
                divide(value, if (value == null || divisor == null || divisor < 0) null else value - divisor)
            OutputCalculationKind.NORMALIZED_RATIO -> {
                val capacity = number(field(context, calculation.capacity))
                divide(value, if (divisor == null || capacity == null || capacity <= 0) null else divisor * capacity)
            }
            OutputCalculationKind.MEAN -> divide(number(field(raw, "sumMs")), number(field(raw, "count")))
            OutputCalculationKind.QUANTILE -> {
                val name =
                    when (calculation.percentile) {
                        0.5 -> "p50Ms"
                        0.95 -> "p95Ms"
                        0.99 -> "p99Ms"
                        else -> null
                    }
                number(field(raw, name))
            }
        }?.takeIf(Double::isFinite)
    }

    /** Resolves object properties only; a catalog path is data, never executable code. */
    fun field(
        context: JsonElement?,
        path: String?,
    ): JsonElement? = path?.split('.')?.fold(context) { value, key -> (value as? JsonObject)?.get(key) }

    private fun number(value: JsonElement?): Double? =
        (value as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf(Double::isFinite)

    private fun divide(
        numerator: Double?,
        denominator: Double?,
    ): Double? = if (numerator == null || denominator == null || denominator <= 0) null else numerator / denominator
}
