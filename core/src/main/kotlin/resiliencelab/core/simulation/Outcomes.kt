package resiliencelab.core.simulation

enum class AttemptOutcome {
    PENDING,
    SUCCEEDED,
    LOCAL_FAILURE,
    DOWNSTREAM_FAILURE,
    TIMED_OUT,
    QUEUE_REJECTED,
    DEADLINE_EXCEEDED,
}
