package resiliencelab.core.ir

/** Token bucket owned by one service instance; [ratePerMs] is the continuous replenishment rate. */
data class RateLimitConfig(
    val ratePerMs: Double,
    val burst: Int,
)

/** Independent readiness probes sharing an instance's handler queue; durations are in milliseconds. */
data class HealthCheckConfig(
    val intervalMs: Double,
    val timeoutMs: Double,
    val unhealthyThreshold: Int,
    val healthyThreshold: Int,
    val processingMs: Double,
)
