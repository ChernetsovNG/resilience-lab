package resiliencelab.core.engine.ksl

import resiliencelab.core.ir.CircuitBreakerConfig
import resiliencelab.core.ir.RetryBudgetConfig

/** Each permit belongs to a state generation, so late completions cannot change a newer open/probe cycle. */
internal class CircuitBreaker(
    private val config: CircuitBreakerConfig,
    private val onOpenChanged: (Boolean) -> Unit,
) {
    private enum class State { CLOSED, OPEN, HALF_OPEN }

    private var state = State.CLOSED
    private var generation = 0L
    private val outcomes = ArrayDeque<Boolean>()
    private var failures = 0
    private var probes = 0
    private var completedProbes = 0

    fun acquire(): Long? =
        when (state) {
            State.CLOSED -> generation
            State.OPEN -> null
            State.HALF_OPEN ->
                if (probes < config.halfOpenCalls) {
                    probes++
                    generation
                } else {
                    null
                }
        }

    fun complete(
        permit: Long,
        succeeded: Boolean,
    ) {
        if (permit != generation) return
        if (!succeeded) failures++
        if (state == State.HALF_OPEN) {
            completedProbes++
            if (completedProbes == config.halfOpenCalls) {
                if (failures.toDouble() / completedProbes >= config.failureRate) open() else reset()
            }
        } else if (state == State.CLOSED) {
            outcomes.addLast(succeeded)
            if (outcomes.size > config.window && !outcomes.removeFirst()) failures--
            if (outcomes.size >= config.minimumCalls && failures.toDouble() / outcomes.size >= config.failureRate) open()
        }
    }

    private fun open() {
        state = State.OPEN
        generation++
        onOpenChanged(true)
    }

    fun halfOpen() {
        if (state != State.OPEN) return
        state = State.HALF_OPEN
        generation++
        failures = 0
        probes = 0
        completedProbes = 0
        onOpenChanged(false)
    }

    fun reset() {
        state = State.CLOSED
        generation++
        outcomes.clear()
        failures = 0
        probes = 0
        completedProbes = 0
    }
}

/** Reservations happen before pool acquisition, so concurrent attempts cannot overspend the rolling allowance. */
internal class RetryBudget(
    private val config: RetryBudgetConfig,
) {
    private val firstAttempts = ArrayDeque<Double>()
    private val retries = ArrayDeque<Double>()

    fun allowsRetry(timeMs: Double): Boolean {
        expire(timeMs)
        return retries.size + 1 <= config.ratio * firstAttempts.size + config.minPerMs * config.windowMs
    }

    fun recordAttempt(
        timeMs: Double,
        retry: Boolean,
    ) {
        expire(timeMs)
        (if (retry) retries else firstAttempts).addLast(timeMs)
    }

    private fun expire(timeMs: Double) {
        val boundary = timeMs - config.windowMs
        for (events in listOf(firstAttempts, retries)) {
            while (events.isNotEmpty() && events.first() <= boundary) events.removeFirst()
        }
    }

    fun reset() {
        firstAttempts.clear()
        retries.clear()
    }
}
