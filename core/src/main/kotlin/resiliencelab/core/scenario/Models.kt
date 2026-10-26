package resiliencelab.core.scenario

import kotlinx.serialization.Serializable

/** A serializable linear service chain with its open workload and optional timed degradation. */
@Serializable
data class Scenario(
    val entry: String,
    val services: List<ServiceSpec>,
    val links: List<LinkSpec>,
    val workload: WorkloadSpec,
    val degradation: DegradationSpec?,
)

/** Configures one service's blocking handlers, bounded FIFO queue, and local processing behavior. */
@Serializable
data class ServiceSpec(
    val id: String,
    val handlers: Int,
    val queueCapacity: Int,
    val processing: DurationDistribution,
    val failureRate: Double,
)

/**
 * Configures a synchronous downstream call.
 * The timeout applies to each attempt, and [maxAttempts] includes the initial attempt.
 */
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

/** A duration law in milliseconds used for local processing or one-way network delay. */
@Serializable
data class DurationDistribution(
    val kind: DistributionKind,
    val meanMs: Double,
    val stdDevMs: Double?,
)

/** Configures capped delays between failed attempts, including full jitter for exponential backoff. */
@Serializable
data class RetrySpec(
    val kind: RetryKind,
    val baseBackoffMs: Double,
    val maxBackoffMs: Double,
    val base: Double = 2.0,
)

/** Configures Poisson original arrivals and the absolute deadline assigned to each arriving request. */
@Serializable
data class WorkloadSpec(
    val arrivalRate: Double,
    val requestDeadlineMs: Double,
)

/**
 * Changes local processing for attempts that start during the specified interval.
 * Duration and failure are sampled once at that start and are not revised when degradation ends.
 */
@Serializable
data class DegradationSpec(
    val serviceId: String,
    val startMs: Double,
    val endMs: Double,
    val processingMultiplier: Double,
    val failureRate: Double?,
)

/**
 * Controls independent replications, warm-up, cohort measurement, and reproducible random streams.
 * Measured requests are followed through run-out after arrivals stop; the real-time cap applies per replication.
 */
@Serializable
data class Execution(
    val replications: Int,
    val warmupMs: Double,
    val measurementMs: Double,
    val seed: Long,
    val maxRealTimeSeconds: Long,
)

/** One scenario in an experiment, with optional metadata identifying its position in a sweep. */
@Serializable
data class ExperimentVariant(
    val id: String,
    val label: String,
    val scenario: Scenario,
    val sweepParameter: SweepParameter?,
    val sweepValue: Double?,
)

/** A versioned set of variants executed under common replication and seed settings. */
@Serializable
data class ExperimentDocument(
    val schemaVersion: Int,
    val execution: Execution,
    val variants: List<ExperimentVariant>,
)

/** Selects one parameter and the ordered values used to create a one-dimensional experiment series. */
@Serializable
data class SweepSpec(
    val parameter: SweepParameter,
    val serviceId: String?,
    val linkId: String?,
    val values: List<Double>,
)

/** A versioned base scenario and sweep definition, expanded before execution. */
@Serializable
data class SweepDocument(
    val schemaVersion: Int,
    val execution: Execution,
    val baseScenario: Scenario,
    val sweep: SweepSpec,
)

/** Supported duration distributions for processing and network delays. */
@Serializable
enum class DistributionKind {
    FIXED,
    EXPONENTIAL,
    LOGNORMAL,
}

/** Supported delay policies between downstream attempts. */
@Serializable
enum class RetryKind {
    NONE,
    FIXED,
    EXPONENTIAL_FULL_JITTER,
}

/** Parameters that can be varied independently in a one-dimensional sweep. */
@Serializable
enum class SweepParameter {
    ARRIVAL_RATE,
    LINK_TIMEOUT,
    MAX_ATTEMPTS,
    BACKOFF_BASE,
    DEGRADATION_MULTIPLIER,
}
