package resiliencelab.core.engine.ksl

/**
 * Invocation and caller-side attempt states mapped to the fixed artifact failure codes.
 * Timeout and deadline outcomes do not cancel accepted downstream work.
 */
enum class AttemptOutcome(
    val failureReason: String? = null,
) {
    PENDING,
    SUCCEEDED,
    LOCAL_FAILURE("error"),
    UNAVAILABLE("unavailable"),
    NO_ROUTE("noRoute"),
    TIMED_OUT("timeout"),
    ACQUIRE_TIMED_OUT("waitLimit"),
    QUEUE_REJECTED("queueFull"),
    DEADLINE_EXCEEDED("deadline"),
    CIRCUIT_OPEN("circuitOpen"),
    RATE_LIMITED("rateLimited"),
    NO_READY_TARGET("noReadyTarget"),
}
