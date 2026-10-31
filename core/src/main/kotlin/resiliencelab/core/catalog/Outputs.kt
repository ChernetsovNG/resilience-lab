package resiliencelab.core.catalog

import kotlinx.serialization.Serializable

/** Meaning of a displayed quantity, independent of its storage and calculation. */
@Serializable
enum class OutputKind { RATE, MEAN_LEVEL, UTILIZATION, FRACTION, LATENCY, COUNT, RATIO }

/** Display units; percentages retain their fractional numeric value until formatting. */
@Serializable
enum class OutputUnit { PER_SECOND, MILLISECONDS, PERCENT, REQUESTS, MULTIPLIER }

/** Closed operations, never executable expressions. RATE multiplies by 1000 before dividing milliseconds. */
@Serializable
enum class OutputCalculationKind { VALUE, RATE, RATIO, NORMALIZED_RATIO, MEAN, QUANTILE }

/**
 * References existing artifact fields by dotted paths. Window paths are relative to the element's row;
 * summary paths are relative to its aggregate. `target` refers to a connection's target block,
 * `entries.total` to all clients' original-arrival counts for the same window, `params` to effective run parameters.
 * `measurementLatency` and `replications` are the selected replication's covered-window statistics and run count.
 * NORMALIZED_RATIO divides [field] by the product of [divisor] and [capacity]; zero divisors mean no value.
 * MEAN and QUANTILE refer to a latency object; only QUANTILE uses [percentile].
 */
@Serializable
data class OutputCalculation(
    val kind: OutputCalculationKind,
    val field: String,
    val divisor: String? = null,
    val capacity: String? = null,
    val percentile: Double? = null,
)

/** Population represented by an output's summary calculation. */
@Serializable
enum class OutputSummarySource { POOLED, REPLICATION, PER_REPLICATION }

/**
 * A summary binding, or null on an output with no summary. [intervalField] optionally identifies an existing
 * MetricSummary: use its mean and unmodified Student bounds; [calculation] is the fallback when it is absent.
 */
@Serializable
data class OutputSummary(
    val calculation: OutputCalculation,
    val source: OutputSummarySource = OutputSummarySource.POOLED,
    val intervalField: String? = null,
)

/** Timeline group and deterministic ordering; the output supplies its label and unit. */
@Serializable
data class OutputTimeline(
    val group: String,
    val groupTitle: String,
    val groupOrder: Int,
    val order: Int,
)

/** Optional inspector row and miniature chart; a chart-only output has [showValue] false. */
@Serializable
data class OutputInspector(
    val title: String,
    val order: Int,
    val showValue: Boolean = true,
    val chartOrder: Int? = null,
    val thresholdParameter: String? = null,
)

/**
 * Canvas selector and badge text. [label] accepts `{value}`, descriptions accept `{interval}`.
 * [scaleParameter] normalizes the color by an effective parameter, without changing the displayed value.
 */
@Serializable
data class OutputOverlay(
    val title: String,
    val label: String,
    val description: String,
    val order: Int,
    val windowDescription: String? = null,
    val scaleParameter: String? = null,
    val scaleTitle: String? = null,
)

/**
 * Stable type-owned output (ADR 0011). Null presentation bindings hide it on that surface; null [summary]
 * means there is no summary value. [approximateWindow] marks a cross-cohort window ratio explicitly.
 * Text is localized by `catalog.types.<typeId>.outputs.<id>.*`; the API's English remains the fallback.
 */
@Serializable
data class OutputDescriptor(
    val id: String,
    val title: String,
    val description: String,
    val unit: OutputUnit,
    val kind: OutputKind,
    val calculation: OutputCalculation,
    val summary: OutputSummary? = null,
    val timeline: OutputTimeline? = null,
    val inspector: OutputInspector? = null,
    val overlay: OutputOverlay? = null,
    val approximateWindow: Boolean = false,
)
