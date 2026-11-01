package resiliencelab.core.catalog

import kotlinx.serialization.Serializable
import java.math.BigDecimal

/**
 * Physical kinds of catalog quantities. Canonical units: milliseconds for [DURATION],
 * requests per millisecond for [RATE], a probability from 0 to 1 for [PROBABILITY].
 */
@Serializable
enum class Dimension {
    DURATION,
    RATE,
    PROBABILITY,
}

/**
 * A unit a document may write: canonical value = written value * [numerator] / [denominator]. The division keeps
 * results like 120/s == 0.12 exact; the catalog lists units so that UI converts values the same way (ADR 0001).
 */
@Serializable
data class QuantityUnit(
    val symbol: String,
    val numerator: Double,
    val denominator: Double,
)

/** Parses and prints document quantities such as `250ms`, `2s`, `120/s` and `0.5%` (ADR 0001, item 6). */
object Quantities {
    private val pattern = Regex("""^([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)(ms|s|min|/ms|/s|/min|%)$""")

    private val units: Map<Dimension, List<QuantityUnit>> =
        mapOf(
            Dimension.DURATION to
                listOf(
                    QuantityUnit("ms", 1.0, 1.0),
                    QuantityUnit("s", 1_000.0, 1.0),
                    QuantityUnit("min", 60_000.0, 1.0),
                ),
            Dimension.RATE to
                listOf(
                    QuantityUnit("/ms", 1.0, 1.0),
                    QuantityUnit("/s", 1.0, 1_000.0),
                    QuantityUnit("/min", 1.0, 60_000.0),
                ),
            Dimension.PROBABILITY to listOf(QuantityUnit("%", 1.0, 100.0)),
        )

    /** Units accepted for [dimension], in display order. */
    fun unitsOf(dimension: Dimension): List<QuantityUnit> = units.getValue(dimension)

    /** Returns the canonical value, or null when [text] is not a finite non-negative quantity of [dimension]. */
    fun parse(
        text: String,
        dimension: Dimension,
    ): Double? {
        val match = pattern.matchEntire(text) ?: return null
        val unit = units.getValue(dimension).firstOrNull { it.symbol == match.groupValues[2] } ?: return null
        val value = match.groupValues[1].toDouble() * unit.numerator / unit.denominator
        return value.takeIf { it.isFinite() }
    }

    /** Formats a canonical value in the base display unit of [dimension]. */
    fun format(
        canonical: Double,
        dimension: Dimension,
    ): String =
        when (dimension) {
            Dimension.DURATION -> "${plain(canonical)}ms"
            Dimension.RATE -> "${plain(canonical * 1_000.0)}/s"
            Dimension.PROBABILITY -> "${plain(canonical * 100.0)}%"
        }

    /** Prints a number without exponent or trailing zeros. */
    fun plain(value: Double): String = plain(BigDecimal.valueOf(value))

    /** Prints a rounded decimal without converting it back to binary floating point. */
    fun plain(value: BigDecimal): String = value.stripTrailingZeros().toPlainString()
}
