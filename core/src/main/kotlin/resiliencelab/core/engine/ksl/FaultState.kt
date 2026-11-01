package resiliencelab.core.engine.ksl

import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan

/**
 * Active faults of one instance. Multipliers multiply, additions sum, independent error probabilities
 * combine as p + q * (1 - p), and available capacity is the minimum. A single error probability is
 * retained exactly and replaces the normal local probability. Blackholes take precedence over fast
 * unavailability. Equal fault records remain separate until each interval ends.
 */
internal class FaultState {
    private val active = mutableListOf<FaultSpan>()
    var multiplier: Double = 1.0
        private set
    var delayMs: Double = 0.0
        private set
    var failureProbability: Double? = null
        private set
    var unavailable: Boolean = false
        private set
    var blackhole: Boolean = false
        private set
    var capacity: Int? = null
        private set

    fun clear() {
        active.clear()
        update()
    }

    fun start(fault: FaultSpan) {
        active.add(fault)
        update()
    }

    fun end(fault: FaultSpan) {
        active.remove(fault)
        update()
    }

    private fun update() {
        multiplier = 1.0
        delayMs = 0.0
        failureProbability = null
        unavailable = false
        blackhole = false
        capacity = null
        // Numeric order makes composition independent of document/event insertion order.
        active
            .sortedWith(compareBy({ it.kind }, { it.multiplier }, { it.delayMs }, { it.failureProbability }, { it.capacity }))
            .forEach { fault ->
                when (fault.kind) {
                    FaultKind.SLOWDOWN -> {
                        multiplier *= fault.multiplier
                        delayMs += fault.delayMs
                    }
                    FaultKind.ERRORS -> {
                        val probability = requireNotNull(fault.failureProbability)
                        failureProbability = failureProbability?.let { it + probability * (1.0 - it) } ?: probability
                    }
                    FaultKind.UNAVAILABLE -> unavailable = true
                    FaultKind.BLACKHOLE -> blackhole = true
                    FaultKind.CAPACITY_LOSS -> capacity = capacity?.let { minOf(it, requireNotNull(fault.capacity)) } ?: fault.capacity
                    FaultKind.FLUSH -> error("Flush is an instantaneous cache event, not an interval fault")
                }
            }
    }
}
