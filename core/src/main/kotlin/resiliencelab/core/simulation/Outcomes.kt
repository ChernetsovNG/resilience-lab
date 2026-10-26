package resiliencelab.core.simulation

/**
 * Describes invocation and caller-side attempt states; timeout and deadline outcomes do not imply cancellation
 * of work already accepted downstream.
 */
enum class AttemptOutcome {
    PENDING,
    SUCCEEDED,
    LOCAL_FAILURE,
    DOWNSTREAM_FAILURE,
    TIMED_OUT,
    QUEUE_REJECTED,
    DEADLINE_EXCEEDED,
}
