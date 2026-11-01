package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import ksl.utilities.statistic.Statistic
import resiliencelab.core.catalog.OutputCalculation
import resiliencelab.core.catalog.OutputCalculationKind
import resiliencelab.core.catalog.OutputCalculator
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.ReplicaGroup
import java.math.BigDecimal
import java.math.MathContext

/**
 * Display statistics for one catalog output in one window. Ordinary outputs use [mean]/[stdDev];
 * quantiles use the pooled [quantile] and replication [min]/[max]. [count] is omitted when every replication contributes.
 * All values have four significant digits; a single observation has no standard deviation.
 */
@Serializable
data class AggregateOutput(
    val mean: Double? = null,
    val stdDev: Double? = null,
    val quantile: Double? = null,
    val min: Double? = null,
    val max: Double? = null,
    val count: Int? = null,
)

/** Named timeline outputs; time bounds follow the containing index and window number, including a shortened final window. */
@Serializable
data class AggregateWindowMetrics(
    val outputs: Map<String, AggregateOutput>,
)

/** One derived row in the current closed window, passed to the shared series packer. */
data class AggregateRowWindow(
    val id: String,
    val metrics: AggregateWindowMetrics,
)

/** Aggregate windows of one node, connection or request class. */
@Serializable
data class AggregateRowSeries(
    val id: String,
    val windows: List<AggregateWindowMetrics>,
)

/** Index of derived parts for one variant and point; omitted output counts equal [replications]. */
@Serializable
data class AggregateSeriesIndex(
    val schemaVersion: Int,
    val endMs: Double,
    val windowMs: Double,
    val replications: Int,
    val parts: List<SeriesPartReference>,
    val groups: List<ReplicaGroup>,
)

/** Aggregate payload; [kind] separates replica instances from ordinary and group rows. */
@Serializable
data class AggregateSeriesPart(
    val schemaVersion: Int,
    val kind: SeriesPartKind,
    val profile: String,
    val replications: Int,
    val fromWindow: Int,
    val untilWindow: Int,
    val nodes: List<AggregateRowSeries>,
    val connections: List<AggregateRowSeries>,
    val classes: List<AggregateRowSeries>,
)

internal object AggregateOutputs {
    fun calculate(
        calculation: OutputCalculation,
        contexts: List<JsonElement>,
    ): AggregateOutput {
        if (calculation.kind == OutputCalculationKind.QUANTILE) {
            val percentile = calculation.percentile
            if (percentile !in listOf(0.5, 0.95, 0.99)) return AggregateOutput(count = 0)
            val sketches =
                contexts.mapNotNull { context ->
                    val bins = OutputCalculator.field(context, "${calculation.field}.sketch") as? JsonArray ?: return@mapNotNull null
                    LatencySketch.fromBins(bins.map { it.jsonPrimitive.long }).takeIf { it.count > 0 }
                }
            val values = sketches.map { requireNotNull(it.percentile(requireNotNull(percentile))) }
            val pooled = LatencySketch()
            sketches.forEach(pooled::merge)
            return AggregateOutput(
                quantile = pooled.percentile(requireNotNull(percentile)).rounded(),
                min = values.minOrNull().rounded(),
                max = values.maxOrNull().rounded(),
                count = values.size.takeIf { it < contexts.size },
            )
        }
        val values = contexts.mapNotNull { OutputCalculator.calculate(calculation, it) }
        val statistic = Statistic(values.toDoubleArray())
        return AggregateOutput(
            mean = statistic.average.takeIf { values.isNotEmpty() }.rounded(),
            stdDev = statistic.standardDeviation.takeIf { values.size >= 2 }.rounded(),
            count = values.size.takeIf { it < contexts.size },
        )
    }

    private fun Double?.rounded(): Double? = this?.let { BigDecimal.valueOf(it).round(MathContext(4)).toDouble() }
}
