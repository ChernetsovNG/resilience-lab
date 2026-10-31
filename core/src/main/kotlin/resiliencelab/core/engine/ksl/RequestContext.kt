package resiliencelab.core.engine.ksl

/** Original request identity and timing, shared unchanged by all attempts and nested service invocations. */
data class RequestContext(
    val clientId: String,
    val requestClass: String,
    val arrivalTimeMs: Double,
    val deadlineMs: Double,
)
