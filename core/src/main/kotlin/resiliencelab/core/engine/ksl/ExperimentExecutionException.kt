package resiliencelab.core.engine.ksl

/** Indicates that execution or result collection failed, so no complete experiment result can be produced. */
class ExperimentExecutionException(
    message: String,
) : RuntimeException(message)
