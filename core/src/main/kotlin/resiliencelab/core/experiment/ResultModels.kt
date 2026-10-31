package resiliencelab.core.experiment

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

/**
 * A fully drained replication for the cohort arriving during the measurement interval.
 * Client outcomes and caused attempts include run-out, while warm-up requests affect state but not these counters.
 */
@Serializable
data class ReplicationResult(
    @Transient val arrivalTimesMs: List<Double> = emptyList(),
    val entries: ReplicationEntries,
    val services: Map<String, ServiceMetrics>,
    val connections: Map<String, ConnectionMetrics> = emptyMap(),
    val poolers: Map<String, PoolerMetrics> = emptyMap(),
    val groups: List<ReplicaGroup> = emptyList(),
)

/** Cohort latency and final outcomes of one total, client or request-class population. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class EntryMetrics(
    @EncodeDefault val allLatency: LatencyStatistics = LatencyStatistics(),
    @EncodeDefault val successfulLatency: LatencyStatistics = LatencyStatistics(),
    @EncodeDefault val failedLatency: LatencyStatistics = LatencyStatistics(),
    @EncodeDefault val originalArrivals: Int = 0,
    @EncodeDefault val successes: Int = 0,
    @EncodeDefault val failures: Int = 0,
    @EncodeDefault val degraded: Int = 0,
    @EncodeDefault val failuresByReason: Map<String, Int> = emptyMap(),
)

/** Every measured request contributes once to total, its client, and its shared request class. */
@Serializable
data class ReplicationEntries(
    val total: EntryMetrics,
    val clients: Map<String, EntryMetrics>,
    val classes: Map<String, EntryMetrics>,
)

/**
 * Per-service counters for the measured cohort and time-weighted observations for the fixed measurement interval.
 * Offered attempts include queue rejections; admitted attempts were queued or immediately allocated.
 * Queue and handler observations include all work present, including warm-up work, but exclude run-out.
 * Residence latency covers admitted attempts of the measured arrival cohort, including run-out completions.
 * [failures] retains local processing failures; [failuresByReason] counts every unsuccessful terminal invocation,
 * including queue rejection and failures propagated from a call.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class ServiceMetrics(
    val offeredAttempts: Int,
    val admittedAttempts: Int,
    val timeouts: Int,
    val retries: Int,
    val failures: Int,
    val measurementMs: Double,
    val queueDurationsMs: Map<Double, Double>,
    val latency: LatencyStatistics = LatencyStatistics(),
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
    @EncodeDefault val failuresByReason: Map<String, Int> = emptyMap(),
    @EncodeDefault val rateLimited: Int = 0,
    @EncodeDefault val probes: Int = 0,
    @EncodeDefault val probeFailures: Int = 0,
    @EncodeDefault val notReadyMs: Double = 0.0,
    @EncodeDefault val ejections: Int = 0,
    @EncodeDefault val ejectedMs: Double = 0.0,
) {
    val handlerUtilization: Double get() = slotPools.getValue("handlers").let { it.busyIntegralMs / it.capacityIntegralMs }
    val meanQueueLength: Double get() = slotPools.getValue("handlers").queueIntegralMs / measurementMs
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
    val entries: AggregateEntries,
    val services: Map<String, AggregateServiceMetrics>,
    val connections: Map<String, AggregateConnectionMetrics> = emptyMap(),
    val poolers: Map<String, AggregatePoolerMetrics> = emptyMap(),
    val groups: List<ReplicaGroup> = emptyList(),
)

/** Independent-replication ratios and percentiles, plus latency pooled within one entry population. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class AggregateEntryMetrics(
    val pooledLatency: LatencySummary,
    val successRate: MetricSummary?,
    val p95LatencyMs: MetricSummary?,
    val p99LatencyMs: MetricSummary?,
    @EncodeDefault val degradedRate: MetricSummary? = null,
    @EncodeDefault val failuresByReason: Map<String, MetricSummary> = emptyMap(),
)

/** Total, client and shared-class summaries use each population's own original-arrival denominator. */
@Serializable
data class AggregateEntries(
    val total: AggregateEntryMetrics,
    val clients: Map<String, AggregateEntryMetrics>,
    val classes: Map<String, AggregateEntryMetrics>,
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
    val pooledLatency: LatencyDistribution? = null,
    val meanLatencyMs: MetricSummary? = null,
    val slotPoolSummaries: Map<String, AggregateSlotPoolMetrics> = emptyMap(),
)

/** Pooled numerators, denominators and time integrals; rates can be reconstructed without averaging rates. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class ServiceTotals(
    val originalArrivals: Long,
    val offeredAttempts: Long,
    val admittedAttempts: Long,
    val timeouts: Long,
    val retries: Long,
    val failures: Long,
    val measurementMs: Double,
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
    @EncodeDefault val failuresByReason: Map<String, Long> = emptyMap(),
    @EncodeDefault val rateLimited: Long = 0L,
    @EncodeDefault val probes: Long = 0L,
    @EncodeDefault val probeFailures: Long = 0L,
    @EncodeDefault val notReadyMs: Double = 0.0,
    @EncodeDefault val ejections: Long = 0L,
    @EncodeDefault val ejectedMs: Double = 0.0,
)

/**
 * Call-attempt counters and response-only latency for the measured arrival cohort, including run-out.
 * Occupancy integrals cover the fixed measurement interval and include all work present, including warm-up.
 * Timeout durations never enter [latency]; orphaned work lasts through the child's response network delay.
 * Pool integrals cover the same fixed interval; wait counts/durations belong to completed waits of the measured
 * cohort, including run-out. Pool acquisition expiry excludes deadline expiry and does not count as a sent attempt.
 * An absent pool is omitted from [slotPools]. [failuresByReason] also includes timed-out attempts and
 * acquisition refusals before sending, whereas [failed] counts received unsuccessful responses.
 */
@OptIn(ExperimentalSerializationApi::class)
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
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
    @EncodeDefault val failuresByReason: Map<String, Int> = emptyMap(),
    @EncodeDefault val circuitOpenMs: Double = 0.0,
    @EncodeDefault val circuitRejections: Int = 0,
    @EncodeDefault val retriesDenied: Int = 0,
    @EncodeDefault val fallbacks: Int = 0,
)

/** Replication-level timeout fraction and mean in-flight occupancy, plus pooled response latency and totals. */
@Serializable
data class AggregateConnectionMetrics(
    val timeoutRate: MetricSummary?,
    val meanInFlight: MetricSummary?,
    val pooledLatency: LatencyDistribution?,
    val totals: ConnectionTotals,
    val meanLatencyMs: MetricSummary? = null,
    val slotPoolSummaries: Map<String, AggregateSlotPoolMetrics> = emptyMap(),
)

/** Pooled call counters and occupancy integrals; [measurementMs] is summed across contributing replications. */
@OptIn(ExperimentalSerializationApi::class)
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
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
    @EncodeDefault val failuresByReason: Map<String, Long> = emptyMap(),
    @EncodeDefault val circuitOpenMs: Double = 0.0,
    @EncodeDefault val circuitRejections: Long = 0L,
    @EncodeDefault val retriesDenied: Long = 0L,
    @EncodeDefault val fallbacks: Long = 0L,
)

/**
 * Transaction-pooler totals for the measured arrival cohort, including run-out. Client rejections are not admitted;
 * admitted failures include wait expiry. Residence covers admission through the reply, including server waiting.
 * Occupancy and queue integrals include all work within the fixed measurement interval, excluding run-out.
 * Wait counts and durations describe completed waits of cohort attempts, including expired waits.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PoolerMetrics(
    val offeredAttempts: Int,
    val admittedAttempts: Int,
    val successes: Int,
    val failures: Int,
    val measurementMs: Double,
    val latency: LatencyStatistics,
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
)

/** Pooled transaction-pooler counters, resource time and residence distribution across independent replications. */
@Serializable
data class AggregatePoolerMetrics(
    val pooledLatency: LatencyDistribution?,
    val totals: PoolerTotals,
)

/** Capacities are integrated over each replication's measurement interval before pooling. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PoolerTotals(
    val offeredAttempts: Long,
    val admittedAttempts: Long,
    val successes: Long,
    val failures: Long,
    val measurementMs: Double,
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
)

/**
 * Common sufficient statistics of one owned slot set. Integrals are slot/queue units × milliseconds.
 * Completed waits (including expiry) count once; immediate acquisitions have no wait sample.
 * Windows use event time; replication totals use the measured arrival cohort including run-out.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SlotPoolMetrics(
    @EncodeDefault val busyIntegralMs: Double = 0.0,
    @EncodeDefault val queueIntegralMs: Double = 0.0,
    @EncodeDefault val capacityIntegralMs: Double = 0.0,
    @EncodeDefault val waitCount: Long = 0L,
    @EncodeDefault val totalWaitMs: Double = 0.0,
    @EncodeDefault val queueFullCount: Long = 0L,
    @EncodeDefault val waitLimitCount: Long = 0L,
    val replicaExtrema: ReplicaSlotExtrema? = null,
)

/** Replica range for one slot set; undefined utilization from zero capacity is excluded. */
@Serializable
data class ReplicaSlotExtrema(
    val minUtilization: Double?,
    val maxUtilization: Double?,
    val maxUtilizationReplica: Int?,
    val minMeanQueueLength: Double,
    val maxMeanQueueLength: Double,
    val maxMeanQueueLengthReplica: Int,
)

/** Replication-level ratios and means of a group's pooled slot statistics. */
@Serializable
data class AggregateSlotPoolMetrics(
    val utilization: MetricSummary?,
    val meanQueueLength: MetricSummary?,
    val meanWaitMs: MetricSummary?,
)

/** Numeric replica identity is retained separately from its display address. */
@Serializable
data class ReplicaMember(
    val id: String,
    val replica: Int,
)

/** Node groups and copied-call groups have independent membership. Router outputs are not groups. */
@Serializable
enum class ReplicaGroupKind { NODE, CONNECTION }

/** Source-document identity and ordered expanded instances of one group. */
@Serializable
data class ReplicaGroup(
    val id: String,
    val kind: ReplicaGroupKind,
    val instances: List<ReplicaMember>,
)
