package resiliencelab.core.ir

/** Count-based breaker owned by one calling instance and connection; durations are in milliseconds. */
data class CircuitBreakerConfig(
    val failureRate: Double,
    val minimumCalls: Int,
    val window: Int,
    val openDurationMs: Double,
    val halfOpenCalls: Int,
)

/** Rolling-window retry allowance: [ratio] times first attempts plus [minPerMs] times [windowMs]. */
data class RetryBudgetConfig(
    val ratio: Double,
    val minPerMs: Double,
    val windowMs: Double,
)

/** Successful replacement of a final call failure whose reason is in [on]; deadline is never replaceable. */
data class FallbackConfig(
    val on: Set<String>,
    val processingMs: Double,
)
