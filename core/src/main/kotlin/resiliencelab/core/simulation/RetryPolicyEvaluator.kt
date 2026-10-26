package resiliencelab.core.simulation

import resiliencelab.core.scenario.RetryKind
import resiliencelab.core.scenario.RetrySpec
import kotlin.math.pow

object RetryPolicyEvaluator {
    fun backoffMs(retry: RetrySpec, failedAttemptNumber: Int, jitter: () -> Double): Double {
        require(failedAttemptNumber >= 1) { "failedAttemptNumber must be at least 1" }
        return when (retry.kind) {
            RetryKind.NONE -> 0.0
            RetryKind.FIXED -> minOf(retry.baseBackoffMs, retry.maxBackoffMs)
            RetryKind.EXPONENTIAL_FULL_JITTER -> {
                val uncappedMs = if (retry.baseBackoffMs == 0.0) {
                    0.0
                } else {
                    retry.baseBackoffMs * retry.base.pow(failedAttemptNumber - 1)
                }
                jitter() * minOf(retry.maxBackoffMs, uncappedMs)
            }
        }
    }
}
