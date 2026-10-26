package resiliencelab.core.experiment

import resiliencelab.core.scenario.SweepParameter
import kotlinx.serialization.Serializable

/** Versioned experiment output containing both replication-level evidence and variant aggregates. */
@Serializable
data class ExperimentResult(
    val schemaVersion: Int,
    val applicationVersion: String,
    val kslVersion: String,
    val variants: List<VariantResult>,
)

/** Results for one scenario, retaining independent replications alongside their aggregate. */
@Serializable
data class VariantResult(
    val id: String,
    val label: String,
    val sweepParameter: SweepParameter? = null,
    val sweepValue: Double? = null,
    val replications: List<ReplicationResult>,
    val aggregate: AggregateMetrics,
)

/**
 * A fully drained replication for the cohort arriving during the measurement interval.
 * Client outcomes and caused attempts include run-out, while warm-up requests affect state but not these counters.
 */
@Serializable
data class ReplicationResult(
    val arrivalTimesMs: List<Double>,
    val allLatenciesMs: List<Double>,
    val successfulLatenciesMs: List<Double>,
    val failedLatenciesMs: List<Double>,
    val originalArrivals: Int,
    val successes: Int,
    val failures: Int,
    val services: Map<String, ServiceMetrics>,
)

/**
 * Per-service counters for the measured cohort and time-weighted observations for the fixed measurement interval.
 * Offered attempts include queue rejections; admitted attempts were queued or immediately allocated.
 * Queue and handler observations include all work present, including warm-up work, but exclude run-out.
 */
@Serializable
data class ServiceMetrics(
    val offeredAttempts: Int,
    val admittedAttempts: Int,
    val timeouts: Int,
    val retries: Int,
    val failures: Int,
    val queueRejections: Int,
    val handlerUtilization: Double,
    val meanQueueLength: Double,
    val p95QueueLength: Double,
)

/** Aggregates pooled latency with replication-level success, percentile, and service amplification summaries. */
@Serializable
data class AggregateMetrics(
    val pooledLatency: LatencySummary,
    val successRate: MetricSummary?,
    val p95LatencyMs: MetricSummary?,
    val p99LatencyMs: MetricSummary?,
    val services: Map<String, AggregateServiceMetrics>,
)

/** Pooled client-latency distributions partitioned by final client outcome. */
@Serializable
data class LatencySummary(
    val all: LatencyDistribution?,
    val successful: LatencyDistribution?,
    val failed: LatencyDistribution?,
)

/** Descriptive statistics for a non-empty set of pooled client latencies. */
@Serializable
data class LatencyDistribution(
    val meanMs: Double,
    val p95Ms: Double,
    val p99Ms: Double,
)

/**
 * Describes replication-level metric values, with uncertainty available only when at least two values exist.
 * Student confidence limits are not clipped to the metric's physical range.
 */
@Serializable
data class MetricSummary(
    val mean: Double,
    val stdDev: Double?,
    val ci95Low: Double?,
    val ci95High: Double?,
    val min: Double,
    val max: Double,
)

/** Summarizes per-replication service amplification using that replication's original-arrival denominator. */
@Serializable
data class AggregateServiceMetrics(
    val admittedAmplification: MetricSummary?,
    val offeredAmplification: MetricSummary?,
)
