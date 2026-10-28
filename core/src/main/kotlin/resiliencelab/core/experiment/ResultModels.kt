package resiliencelab.core.experiment

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

/**
 * A fully drained replication for the cohort arriving during the measurement interval.
 * Client outcomes and caused attempts include run-out, while warm-up requests affect state but not these counters.
 */
@Serializable
data class ReplicationResult(
    @Transient val arrivalTimesMs: List<Double> = emptyList(),
    val allLatency: LatencyStatistics,
    val successfulLatency: LatencyStatistics,
    val failedLatency: LatencyStatistics,
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
    val handlers: Int,
    val measurementMs: Double,
    val busyHandlerTimeMs: Double,
    val queueLengthIntegralMs: Double,
    val queueDurationsMs: Map<Double, Double>,
) {
    val handlerUtilization: Double get() = busyHandlerTimeMs / (handlers * measurementMs)
    val meanQueueLength: Double get() = queueLengthIntegralMs / measurementMs
    val p95QueueLength: Double
        get() {
            val target = 0.95 * queueDurationsMs.values.sum()
            var cumulative = 0.0
            for ((length, duration) in queueDurationsMs.toSortedMap()) {
                cumulative += duration
                if (cumulative >= target) return length
            }
            return 0.0
        }
}

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
    val statistics: LatencyStatistics,
)

/**
 * Describes replication-level metric values, with uncertainty available only when at least two values exist.
 * Student confidence limits are not clipped to the metric's physical range.
 * Latency percentiles use the S5 sketch profile (at most 0.78125% representation error in the tested latency
 * range), retaining KSL interpolation. This approximation bound is separate from replication uncertainty.
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
    val totals: ServiceTotals,
)

/** Pooled numerators, denominators and time integrals; rates can be reconstructed without averaging rates. */
@Serializable
data class ServiceTotals(
    val originalArrivals: Long,
    val offeredAttempts: Long,
    val admittedAttempts: Long,
    val timeouts: Long,
    val retries: Long,
    val failures: Long,
    val queueRejections: Long,
    val busyHandlerTimeMs: Double,
    val handlerCapacityTimeMs: Double,
    val queueLengthIntegralMs: Double,
    val measurementMs: Double,
)
