package resiliencelab.core.compiler

import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.ServiceNode
import java.math.BigInteger
import kotlin.math.pow

/**
 * Advisory checks on valid, compiled linear chains (stage-1 design §3.4).
 * Durations use milliseconds and arrival rates use requests per millisecond, as in the engine.
 * These static estimates omit queueing and degradation; distribution means cannot bound random tails.
 */
class ModelLinter(
    private val retryAmplificationThreshold: Int = 10,
) {
    init {
        require(retryAmplificationThreshold >= 1) { "retryAmplificationThreshold must be at least 1" }
    }

    /** Returns advisory diagnostics; callers must continue to accept warning-only models. */
    fun lint(experiment: CompiledExperiment): List<Diagnostic> =
        experiment.variants
            .flatMap { variant ->
                lintChain(variant.chain).map { diagnostic ->
                    val parameter = diagnostic.pointer?.substringAfter("/params/")?.replace('/', '.')
                    val origin = variant.parameterOrigins["${diagnostic.path}.$parameter"]
                    val located =
                        if (origin == null) {
                            diagnostic
                        } else {
                            diagnostic.copy(document = origin.document, pointer = origin.pointer, variant = variant.id)
                        }
                    located to variant.id
                }
            }.groupBy({ it.first }, { it.second })
            .flatMap { (diagnostic, variants) ->
                if (variants.size == experiment.variants.size) {
                    listOf(diagnostic)
                } else {
                    variants.map { diagnostic.copy(variant = it) }
                }
            }

    private fun lintChain(chain: ChainIr): List<Diagnostic> {
        val services = chain.services.associateBy { it.path }
        val outgoing = chain.calls.associateBy { it.from }
        val ordered = generateSequence(chain.entry) { outgoing[it]?.to }.map { services.getValue(it) }.toList()
        return buildList {
            chain.calls.forEach { call ->
                timeoutBudget(call, services.getValue(call.to), outgoing[call.to])?.let(::add)
            }
            retryAmplification(chain, outgoing[chain.entry])?.let(::add)
            addAll(handlerDemand(chain, ordered, outgoing))
            deadlineBudget(chain)?.let(::add)
        }
    }

    /**
     * An incoming attempt covers both network directions and the target's local processing before its next call.
     * Required budget = 2 × incoming network mean + target processing mean + next attempts × next timeout
     * + the sum of maximum backoffs between those attempts. A leaf has no next-call contribution.
     * The next timeout already covers that call's network, so its network delay is not added again.
     */
    private fun timeoutBudget(
        call: CallEdge,
        target: ServiceNode,
        next: CallEdge?,
    ): Diagnostic? {
        val required =
            2.0 * call.network.meanMs + target.processing.meanMs + (next?.let { it.attempts * it.timeoutMs + maxBackoffSum(it) } ?: 0.0)
        return if (call.timeoutMs < required) {
            warning(
                "LINT_TIMEOUT_BUDGET",
                "Timeout ${call.timeoutMs} ms is below the downstream budget $required ms",
                call.origin,
                call.path,
                "/params/timeout",
            )
        } else {
            null
        }
    }

    /** Attempts include the first attempt. Multiplication is exact, including chains whose product exceeds Long. */
    private fun retryAmplification(
        chain: ChainIr,
        firstCall: CallEdge?,
    ): Diagnostic? {
        val product = chain.calls.fold(BigInteger.ONE) { total, call -> total * BigInteger.valueOf(call.attempts.toLong()) }
        return if (product > BigInteger.valueOf(retryAmplificationThreshold.toLong()) && firstCall != null) {
            warning(
                "LINT_RETRY_AMPLIFICATION",
                "Retry amplification $product exceeds threshold $retryAmplificationThreshold",
                firstCall.origin,
                firstCall.path,
                "/params/attempts",
            )
        } else {
            null
        }
    }

    /**
     * On the successful path without queueing, failures or retries, W(service) = processing mean
     * + 2 × outgoing network mean + W(next service). A leaf's W is its processing mean.
     * The service holds its handler while waiting downstream, and releases it before its own response network delay.
     * Compare handlers with client arrivalRatePerMs × W; this is the offered-load estimate before timeout truncation.
     */
    private fun handlerDemand(
        chain: ChainIr,
        ordered: List<ServiceNode>,
        outgoing: Map<String, CallEdge>,
    ): List<Diagnostic> {
        var holdingMs = 0.0
        return buildList {
            ordered.asReversed().forEach { service ->
                holdingMs += service.processing.meanMs + 2.0 * (outgoing[service.path]?.network?.meanMs ?: 0.0)
                val demand = chain.client.arrivalRatePerMs * holdingMs
                if (service.handlers < demand) {
                    add(
                        warning(
                            "LINT_HANDLERS_LITTLE",
                            "Handlers ${service.handlers} are below λ·W = $demand " +
                                "(λ = ${chain.client.arrivalRatePerMs * 1_000.0} requests/s, W = $holdingMs ms)",
                            service.origin,
                            service.path,
                            "/params/handlers",
                        ),
                    )
                }
            }
        }
    }

    /**
     * Compare the client deadline with Σ(attempts × timeout) across all calls, as specified in T1.2.
     * Each timeout already includes request and response network delays. This conservative comparison can overlap
     * nested timeout budgets; local processing and backoffs are outside this particular timeout-sum rule.
     */
    private fun deadlineBudget(chain: ChainIr): Diagnostic? {
        val required = chain.calls.sumOf { it.attempts * it.timeoutMs }
        return if (chain.client.deadlineMs < required) {
            warning(
                "LINT_DEADLINE_BUDGET",
                "Deadline ${chain.client.deadlineMs} ms is below the timeout sum $required ms",
                chain.client.origin,
                chain.client.path,
                "/params/deadline",
            )
        } else {
            null
        }
    }

    /**
     * There are attempts − 1 backoffs. NONE contributes zero, FIXED uses min(base, max), and full jitter's
     * supremum after failed attempt k is min(max, base × multiplier^(k − 1)), matching RetryPolicyEvaluator.
     * Split the monotone sequence at its cap and sum its geometric part in O(log attempts), including multipliers < 1.
     */
    private fun maxBackoffSum(call: CallEdge): Double {
        val count = call.attempts - 1
        val backoff = call.backoff
        if (count == 0 || backoff.kind == BackoffKind.NONE || backoff.baseMs == 0.0 || backoff.maxMs == 0.0) return 0.0
        if (backoff.kind == BackoffKind.FIXED || backoff.multiplier == 1.0) return count * minOf(backoff.baseMs, backoff.maxMs)
        return exponentialBackoffSum(backoff, count)
    }

    private fun exponentialBackoffSum(
        backoff: Backoff,
        count: Int,
    ): Double {
        val growing = backoff.multiplier > 1.0
        var low = 0
        var high = count
        while (low < high) {
            val middle = low + (high - low) / 2
            val capped = backoff.baseMs * backoff.multiplier.pow(middle) >= backoff.maxMs
            if (capped == growing) high = middle else low = middle + 1
        }
        val uncapped = if (growing) low else count - low
        val capped = count - uncapped
        val geometric =
            if (uncapped == 0) {
                0.0
            } else {
                val index = if (growing) uncapped - 1 else capped
                val first = backoff.baseMs * backoff.multiplier.pow(index)
                geometricSum(first, if (growing) 1.0 / backoff.multiplier else backoff.multiplier, uncapped)
            }
        return capped * backoff.maxMs + geometric
    }

    /** Sums first × (1 + ratio + …) by doubling; ratio ≤ 1 avoids overflowing intermediate powers. */
    private fun geometricSum(
        first: Double,
        ratio: Double,
        count: Int,
    ): Double {
        var remaining = count
        var blockSum = 1.0
        var blockPower = ratio
        var offsetPower = 1.0
        var sum = 0.0
        while (remaining > 0) {
            if (remaining and 1 == 1) {
                sum += offsetPower * blockSum
                offsetPower *= blockPower
            }
            blockSum *= 1.0 + blockPower
            blockPower *= blockPower
            remaining = remaining ushr 1
        }
        return first * sum
    }

    private fun warning(
        code: String,
        message: String,
        origin: Origin,
        path: String,
        suffix: String,
    ) = Diagnostic(code, Severity.WARNING, message, origin.document, origin.pointer + suffix, path)
}
