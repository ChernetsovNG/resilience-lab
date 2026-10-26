package resiliencelab.core.scenario

import kotlinx.serialization.Serializable

@Serializable
data class Scenario(
    val entry: String,
    val services: List<ServiceSpec>,
    val links: List<LinkSpec>,
    val workload: WorkloadSpec,
    val degradation: DegradationSpec?,
)

@Serializable
data class ServiceSpec(
    val id: String,
    val handlers: Int,
    val queueCapacity: Int,
    val processing: DurationDistribution,
    val failureRate: Double,
)

@Serializable
data class LinkSpec(
    val id: String,
    val from: String,
    val to: String,
    val network: DurationDistribution,
    val timeoutMs: Double,
    val maxAttempts: Int,
    val retry: RetrySpec,
)

@Serializable
data class DurationDistribution(
    val kind: DistributionKind,
    val meanMs: Double,
    val stdDevMs: Double?,
)

@Serializable
data class RetrySpec(
    val kind: RetryKind,
    val baseBackoffMs: Double,
    val maxBackoffMs: Double,
    val base: Double = 2.0,
)

@Serializable
data class WorkloadSpec(
    val arrivalRate: Double,
    val requestDeadlineMs: Double,
)

@Serializable
data class DegradationSpec(
    val serviceId: String,
    val startMs: Double,
    val endMs: Double,
    val processingMultiplier: Double,
    val failureRate: Double?,
)

@Serializable
data class Execution(
    val replications: Int,
    val warmupMs: Double,
    val measurementMs: Double,
    val seed: Long,
    val maxRealTimeSeconds: Long,
)

@Serializable
data class ExperimentVariant(
    val id: String,
    val label: String,
    val scenario: Scenario,
    val sweepParameter: SweepParameter?,
    val sweepValue: Double?,
)

@Serializable
data class ExperimentDocument(
    val schemaVersion: Int,
    val execution: Execution,
    val variants: List<ExperimentVariant>,
)

@Serializable
data class SweepSpec(
    val parameter: SweepParameter,
    val serviceId: String?,
    val linkId: String?,
    val values: List<Double>,
)

@Serializable
data class SweepDocument(
    val schemaVersion: Int,
    val execution: Execution,
    val baseScenario: Scenario,
    val sweep: SweepSpec,
)

@Serializable
enum class DistributionKind {
    FIXED,
    EXPONENTIAL,
    LOGNORMAL,
}

@Serializable
enum class RetryKind {
    NONE,
    FIXED,
    EXPONENTIAL_FULL_JITTER,
}

@Serializable
enum class SweepParameter {
    ARRIVAL_RATE,
    LINK_TIMEOUT,
    MAX_ATTEMPTS,
    BACKOFF_BASE,
    DEGRADATION_MULTIPLIER,
}
