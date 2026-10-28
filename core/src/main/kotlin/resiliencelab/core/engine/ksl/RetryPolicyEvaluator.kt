package resiliencelab.core.engine.ksl

import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.scenario.RetrySpec
import kotlin.math.pow

/**
 * Computes capped retry delays for one-based failed-attempt numbers.
 * Exponential full jitter samples uniformly between zero and the capped exponential delay.
 */
object RetryPolicyEvaluator {
    fun backoffMs(
        backoff: Backoff,
        failedAttemptNumber: Int,
        jitter: () -> Double,
    ): Double {
        require(failedAttemptNumber >= 1) { "failedAttemptNumber must be at least 1" }
        return when (backoff.kind) {
            BackoffKind.NONE -> 0.0
            BackoffKind.FIXED -> minOf(backoff.baseMs, backoff.maxMs)
            BackoffKind.EXPONENTIAL_FULL_JITTER -> {
                val uncappedMs =
                    if (backoff.baseMs == 0.0) {
                        0.0
                    } else {
                        backoff.baseMs * backoff.multiplier.pow(failedAttemptNumber - 1)
                    }
                jitter() * minOf(backoff.maxMs, uncappedMs)
            }
        }
    }

    /** MVP overload; removed with the `scenario` package. */
    fun backoffMs(
        retry: RetrySpec,
        failedAttemptNumber: Int,
        jitter: () -> Double,
    ): Double = backoffMs(LegacyScenarioAdapter.backoff(retry), failedAttemptNumber, jitter)
}
