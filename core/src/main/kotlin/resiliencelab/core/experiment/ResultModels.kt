package resiliencelab.core.experiment

import resiliencelab.core.scenario.SweepParameter
import kotlinx.serialization.Serializable

@Serializable
data class ExperimentResult(
    val schemaVersion: Int,
    val applicationVersion: String,
    val kslVersion: String,
    val variants: List<VariantResult>,
)

@Serializable
data class VariantResult(
    val id: String,
    val label: String,
    val sweepParameter: SweepParameter? = null,
    val sweepValue: Double? = null,
    val replications: List<ReplicationResult>,
    val aggregate: AggregateMetrics,
)

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

@Serializable
data class AggregateMetrics(
    val pooledLatency: LatencySummary,
    val successRate: MetricSummary?,
    val p95LatencyMs: MetricSummary?,
    val p99LatencyMs: MetricSummary?,
    val services: Map<String, AggregateServiceMetrics>,
)

@Serializable
data class LatencySummary(
    val all: LatencyDistribution?,
    val successful: LatencyDistribution?,
    val failed: LatencyDistribution?,
)

@Serializable
data class LatencyDistribution(
    val meanMs: Double,
    val p95Ms: Double,
    val p99Ms: Double,
)

@Serializable
data class MetricSummary(
    val mean: Double,
    val stdDev: Double?,
    val ci95Low: Double?,
    val ci95High: Double?,
    val min: Double,
    val max: Double,
)

@Serializable
data class AggregateServiceMetrics(
    val admittedAmplification: MetricSummary?,
    val offeredAmplification: MetricSummary?,
)
