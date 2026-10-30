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
    val connections: Map<String, ConnectionMetrics> = emptyMap(),
    val poolers: Map<String, PoolerMetrics> = emptyMap(),
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
    val connections: Map<String, AggregateConnectionMetrics> = emptyMap(),
    val poolers: Map<String, AggregatePoolerMetrics> = emptyMap(),
)

/** Pooled client-latency distributions partitioned by final client outcome. */
@Serializable
data class LatencySummary(
    val all: LatencyDistribution?,
    val successful: LatencyDistribution?,
    val failed: LatencyDistribution?,
)

/** Descriptive statistics for a non-empty set of pooled client or call-response latencies. */
@Serializable
data class LatencyDistribution(
    val meanMs: Double,
    val p95Ms: Double,
    val p99Ms: Double,
    val statistics: LatencyStatistics,
)

/**
 * Describes [count] contributing replication-level values; uncertainty needs at least two values.
 * Student confidence limits are not clipped to the metric's physical range.
 * Latency percentiles use the S5 sketch profile (at most 0.78125% representation error in the tested latency
 * range), retaining KSL interpolation. This approximation bound is separate from replication uncertainty.
 */
@Serializable
data class MetricSummary(
    val count: Int,
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

/**
 * Call-attempt counters and response-only latency for the measured arrival cohort, including run-out.
 * Occupancy integrals cover the fixed measurement interval and include all work present, including warm-up.
 * Timeout durations never enter [latency]; orphaned work lasts through the child's response network delay.
 * Pool integrals cover the same fixed interval; wait counts/durations belong to completed waits of the measured
 * cohort, including run-out. Pool acquisition expiry excludes deadline expiry and does not count as a sent attempt.
 * All pool fields default to zero when no pool exists.
 */
@Serializable
data class ConnectionMetrics(
    val sentAttempts: Int,
    val retries: Int,
    val succeeded: Int,
    val failed: Int,
    val timeouts: Int,
    val orphaned: Int,
    val inFlightIntegralMs: Double,
    val orphanedIntegralMs: Double,
    val backoffIntegralMs: Double,
    val measurementMs: Double,
    val latency: LatencyStatistics,
    val poolBusyTimeMs: Double = 0.0,
    val poolCapacityTimeMs: Double = 0.0,
    val poolQueueIntegralMs: Double = 0.0,
    val poolWaitCount: Int = 0,
    val poolWaitTimeMs: Double = 0.0,
    val poolAcquireTimeouts: Int = 0,
)

/** Replication-level timeout fraction and mean in-flight occupancy, plus pooled response latency and totals. */
@Serializable
data class AggregateConnectionMetrics(
    val timeoutRate: MetricSummary?,
    val meanInFlight: MetricSummary?,
    val pooledLatency: LatencyDistribution?,
    val totals: ConnectionTotals,
)

/** Pooled call counters and occupancy integrals; [measurementMs] is summed across contributing replications. */
@Serializable
data class ConnectionTotals(
    val sentAttempts: Long,
    val retries: Long,
    val succeeded: Long,
    val failed: Long,
    val timeouts: Long,
    val orphaned: Long,
    val inFlightIntegralMs: Double,
    val orphanedIntegralMs: Double,
    val backoffIntegralMs: Double,
    val measurementMs: Double,
    val poolBusyTimeMs: Double = 0.0,
    val poolCapacityTimeMs: Double = 0.0,
    val poolQueueIntegralMs: Double = 0.0,
    val poolWaitCount: Long = 0L,
    val poolWaitTimeMs: Double = 0.0,
    val poolAcquireTimeouts: Long = 0L,
)

/**
 * Transaction-pooler totals for the measured arrival cohort, including run-out. Client rejections are not admitted;
 * admitted failures include wait expiry. Residence covers admission through the reply, including server waiting.
 * Occupancy and queue integrals include all work within the fixed measurement interval, excluding run-out.
 * Wait counts and durations describe completed waits of cohort attempts, including expired waits.
 */
@Serializable
data class PoolerMetrics(
    val offeredAttempts: Int,
    val admittedAttempts: Int,
    val clientConnectionRejections: Int,
    val waitTimeouts: Int,
    val successes: Int,
    val failures: Int,
    val maxClientConnections: Int,
    val poolSize: Int,
    val measurementMs: Double,
    val busyClientConnectionTimeMs: Double,
    val busyServerConnectionTimeMs: Double,
    val serverQueueLengthIntegralMs: Double,
    val serverWaitCount: Int,
    val serverWaitTimeMs: Double,
    val latency: LatencyStatistics,
)

/** Pooled transaction-pooler counters, resource time and residence distribution across independent replications. */
@Serializable
data class AggregatePoolerMetrics(
    val pooledLatency: LatencyDistribution?,
    val totals: PoolerTotals,
)

/** Capacities are integrated over each replication's measurement interval before pooling. */
@Serializable
data class PoolerTotals(
    val offeredAttempts: Long,
    val admittedAttempts: Long,
    val clientConnectionRejections: Long,
    val waitTimeouts: Long,
    val successes: Long,
    val failures: Long,
    val busyClientConnectionTimeMs: Double,
    val clientConnectionCapacityTimeMs: Double,
    val busyServerConnectionTimeMs: Double,
    val serverConnectionCapacityTimeMs: Double,
    val serverQueueLengthIntegralMs: Double,
    val serverWaitCount: Long,
    val serverWaitTimeMs: Double,
    val measurementMs: Double,
)
