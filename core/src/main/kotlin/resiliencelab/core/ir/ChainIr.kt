package resiliencelab.core.ir

/** Shape of a duration distribution. */
enum class DistributionShape {
    FIXED,
    EXPONENTIAL,
    LOGNORMAL,
}

/** Duration distribution in milliseconds; [stdDevMs] is set for [DistributionShape.LOGNORMAL] only. */
data class Distribution(
    val shape: DistributionShape,
    val meanMs: Double,
    val stdDevMs: Double? = null,
)

/** Delay policy between attempts. */
enum class BackoffKind {
    NONE,
    FIXED,
    EXPONENTIAL_FULL_JITTER,
}

/** Backoff in milliseconds; [multiplier] grows exponential delays. */
data class Backoff(
    val kind: BackoffKind,
    val baseMs: Double,
    val maxMs: Double,
    val multiplier: Double,
)

/** Where an IR element is defined (ADR 0002, item 3): the document and the JSON pointer in it. */
data class Origin(
    val document: String,
    val pointer: String,
) {
    companion object {
        /** Origin of IR built in code rather than compiled from documents (tests, the MVP adapter). */
        val UNSPECIFIED = Origin("", "")
    }
}

/** Source of original requests. */
data class ClientNode(
    val path: String,
    val arrivalRatePerMs: Double,
    val deadlineMs: Double,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Blocking service with a bounded FIFO queue. */
data class ServiceNode(
    val path: String,
    val handlers: Int,
    val queueCapacity: Int,
    val processing: Distribution,
    val failureProbability: Double,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Synchronous call from [from] to [to]. */
data class CallEdge(
    val path: String,
    val from: String,
    val to: String,
    val network: Distribution,
    val timeoutMs: Double,
    val attempts: Int,
    val backoff: Backoff,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Degradation of [target] while local processing starts within [fromMs, toMs). */
data class FaultSpan(
    val target: String,
    val fromMs: Double,
    val toMs: Double,
    val processingMultiplier: Double?,
    val failureProbability: Double?,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Replications, measurement window, seed and real-time cap of a run. */
data class RunSettings(
    val replications: Int,
    val warmupMs: Double,
    val measurementMs: Double,
    val seed: Long,
    val maxRealTimeSeconds: Long,
)

/**
 * Engine-neutral form of one variant (ADR 0002): a linear chain from [client] through [entry].
 * The compiler orders services, calls and faults canonically so that document order never changes a run.
 */
data class ChainIr(
    val client: ClientNode,
    val entry: String,
    val services: List<ServiceNode>,
    val calls: List<CallEdge>,
    val faults: List<FaultSpan>,
    val run: RunSettings,
) {
    fun outgoingCall(from: String): CallEdge? = calls.firstOrNull { it.from == from }
}
