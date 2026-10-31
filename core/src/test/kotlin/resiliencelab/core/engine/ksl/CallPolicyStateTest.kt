package resiliencelab.core.engine.ksl

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.ir.CircuitBreakerConfig
import resiliencelab.core.ir.RetryBudgetConfig

class CallPolicyStateTest {
    @Test
    fun `closed window evicts old outcomes before evaluating the threshold`() {
        val changes = mutableListOf<Boolean>()
        val breaker = CircuitBreaker(CircuitBreakerConfig(0.75, 4, 4, 10.0, 2), changes::add)
        for (success in listOf(false, true, true, true, false, false)) {
            breaker.complete(requireNotNull(breaker.acquire()), success)
            assertThat(changes).isEmpty()
        }
        breaker.complete(requireNotNull(breaker.acquire()), false)
        assertThat(changes).containsExactly(true)
        assertThat(breaker.acquire()).isNull()
    }

    @Test
    fun `half open limits concurrent probes waits for their outcomes and closes on success`() {
        val changes = mutableListOf<Boolean>()
        val breaker = CircuitBreaker(CircuitBreakerConfig(0.5, 1, 2, 10.0, 2), changes::add)
        val late = requireNotNull(breaker.acquire())
        breaker.complete(requireNotNull(breaker.acquire()), false)
        assertThat(breaker.acquire()).isNull()
        breaker.halfOpen()
        val first = requireNotNull(breaker.acquire())
        val second = requireNotNull(breaker.acquire())
        assertThat(breaker.acquire()).isNull()
        breaker.complete(first, true)
        assertThat(breaker.acquire()).isNull()
        breaker.complete(late, false)
        breaker.complete(second, true)
        assertThat(breaker.acquire()).isNotNull()
        assertThat(changes).containsExactly(true, false)
        breaker.complete(requireNotNull(breaker.acquire()), true)
        assertThat(changes).containsExactly(true, false)
    }

    @Test
    fun `half open reopens at the failure threshold and reset removes previous state`() {
        val changes = mutableListOf<Boolean>()
        val breaker = CircuitBreaker(CircuitBreakerConfig(0.5, 1, 2, 10.0, 2), changes::add)
        breaker.complete(requireNotNull(breaker.acquire()), false)
        breaker.halfOpen()
        val first = requireNotNull(breaker.acquire())
        val second = requireNotNull(breaker.acquire())
        breaker.complete(first, false)
        breaker.complete(second, true)
        assertThat(breaker.acquire()).isNull()
        assertThat(changes).containsExactly(true, false, true)
        breaker.reset()
        assertThat(breaker.acquire()).isNotNull()
        breaker.complete(second, false)
        assertThat(breaker.acquire()).isNotNull()
    }

    @Test
    fun `fractional budget reservations expire at the window boundary`() {
        val budget = RetryBudget(RetryBudgetConfig(0.5, 0.0, 10.0))
        budget.recordAttempt(0.0, false)
        assertThat(budget.allowsRetry(0.0)).isFalse()
        budget.recordAttempt(1.0, false)
        assertThat(budget.allowsRetry(1.0)).isTrue()
        budget.recordAttempt(1.0, true)
        assertThat(budget.allowsRetry(1.0)).isFalse()
        budget.recordAttempt(10.0, false)
        assertThat(budget.allowsRetry(10.0)).isFalse()
        budget.recordAttempt(11.0, false)
        assertThat(budget.allowsRetry(11.0)).isTrue()
        budget.reset()
        assertThat(budget.allowsRetry(11.0)).isFalse()
    }
}
