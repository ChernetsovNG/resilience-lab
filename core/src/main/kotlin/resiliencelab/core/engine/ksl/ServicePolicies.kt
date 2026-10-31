package resiliencelab.core.engine.ksl

import resiliencelab.core.ir.HealthCheckConfig
import resiliencelab.core.ir.RateLimitConfig

/** Continuous refill with an initially full, per-instance bucket; no random draws or scheduled events. */
internal class TokenBucket(
    private val config: RateLimitConfig,
) {
    private var tokens = config.burst.toDouble()
    private var lastMs = 0.0

    fun reset() {
        tokens = config.burst.toDouble()
        lastMs = 0.0
    }

    fun acquire(timeMs: Double): Boolean {
        tokens = minOf(config.burst.toDouble(), tokens + (timeMs - lastMs) * config.ratePerMs)
        lastMs = timeMs
        if (tokens < 1.0) return false
        tokens -= 1.0
        return true
    }
}

/** One instance's readiness, shared by all routers; the opposite outcome resets a consecutive streak. */
internal class ServiceHealth(
    private val config: HealthCheckConfig,
    private val onReadyChanged: (Boolean) -> Unit,
) {
    var ready = true
        private set
    private var failures = 0
    private var successes = 0

    fun reset() {
        ready = true
        failures = 0
        successes = 0
    }

    fun complete(succeeded: Boolean) {
        if (succeeded) {
            failures = 0
            successes = minOf(successes, config.healthyThreshold - 1) + 1
        } else {
            successes = 0
            failures = minOf(failures, config.unhealthyThreshold - 1) + 1
        }
        val next =
            when {
                failures >= config.unhealthyThreshold -> false
                successes >= config.healthyThreshold -> true
                else -> ready
            }
        if (next != ready) {
            ready = next
            onReadyChanged(ready)
        }
    }
}
