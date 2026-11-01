package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import ksl.utilities.distributions.Normal
import resiliencelab.core.catalog.Quantities
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import java.math.BigDecimal
import java.math.BigInteger
import java.math.MathContext
import java.math.RoundingMode
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.ln1p
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Advisory checks on valid, compiled paths from the client (stage-1 design §3.4).
 * Durations use milliseconds and arrival rates use requests per millisecond, as in the engine.
 * These static holding-time estimates omit queueing and degradation; distribution means cannot bound random tails.
 * [minimumReplications] is the positive threshold for the experiment-wide confidence-interval warning.
 * [retryOverloadThreshold] is the positive accepted-utilization threshold for worst-case retries (1 by default).
 * [retryNoJitterThreshold] is the attempt count above which NONE and FIXED backoffs warn (1 by default).
 * [queueWaitThreshold] scales the caller's patience for full-queue warnings (1 by default, equality allowed).
 * [timeoutBudgetTolerance] allows a relative downstream reserve above the incoming timeout (5% by default).
 * [timeoutUnreachableThreshold] compares a call timeout with this multiple of each reachable client's deadline (1 by default).
 * [timeoutLatencyQuantile] selects the target processing quantile for normal-response estimates (0.99 by default).
 */
class ModelLinter(
    private val retryAmplificationThreshold: Int = 10,
    private val minimumReplications: Int = 5,
    private val timeoutBudgetTolerance: Double = 0.05,
    private val timeoutUnreachableThreshold: Double = 1.0,
    private val retryNoJitterThreshold: Int = 1,
    private val timeoutLatencyQuantile: Double = 0.99,
    private val queueWaitThreshold: Double = 1.0,
    private val retryOverloadThreshold: Double = 1.0,
) {
    init {
        require(retryOverloadThreshold.isFinite() && retryOverloadThreshold > 0.0) {
            "retryOverloadThreshold must be finite and positive"
        }
        require(retryAmplificationThreshold >= 1) { "retryAmplificationThreshold must be at least 1" }
        require(retryNoJitterThreshold >= 1) { "retryNoJitterThreshold must be at least 1" }
        require(minimumReplications >= 1) { "minimumReplications must be at least 1" }
        require(timeoutBudgetTolerance.isFinite() && timeoutBudgetTolerance >= 0.0) {
            "timeoutBudgetTolerance must be finite and non-negative"
        }
        require(timeoutUnreachableThreshold.isFinite() && timeoutUnreachableThreshold >= 1.0) {
            "timeoutUnreachableThreshold must be finite and at least 1"
        }
        require(queueWaitThreshold.isFinite() && queueWaitThreshold >= 1.0) {
            "queueWaitThreshold must be finite and at least 1"
        }
        require(timeoutLatencyQuantile.isFinite() && timeoutLatencyQuantile > 0.0 && timeoutLatencyQuantile < 1.0) {
            "timeoutLatencyQuantile must be finite and strictly between 0 and 1"
        }
    }

    /**
     * Returns advisory diagnostics; callers must continue to accept warning-only models. Grid findings retain
     * their variant and name the affected points unless the same finding occurs at every point of that variant.
     * The replication warning occurs once per experiment, with no variant or grid-point scope.
     */
    fun lint(experiment: CompiledExperiment): List<Diagnostic> =
        experiment.variants
            .flatMap { variant ->
                variant.points
                    .flatMap { point ->
                        lintGraph(point.graph).map { diagnostic ->
                            val parameter = diagnostic.pointer?.substringAfter("/params/")?.replace('/', '.')
                            val origin =
                                generateSequence(parameter) { it.substringBeforeLast('.', "").takeIf { parent -> parent.isNotEmpty() } }
                                    .firstNotNullOfOrNull { point.parameterOrigins["${diagnostic.path}.$it"] }
                            val located =
                                if (origin == null) {
                                    diagnostic
                                } else {
                                    diagnostic.copy(
                                        document = origin.document,
                                        pointer = origin.pointer,
                                        variant = variant.id,
                                    )
                                }
                            located to point.id
                        }
                    }.groupBy({ it.first }, { it.second })
                    .map { (diagnostic, points) ->
                        diagnostic.copy(
                            message =
                                if (points.size == variant.points.size) {
                                    diagnostic.message
                                } else {
                                    "${diagnostic.message} (points: ${points.joinToString(", ")})"
                                },
                            variant = if (experiment.grid.isNotEmpty()) variant.id else diagnostic.variant,
                            args =
                                if (points.size == variant.points.size) {
                                    diagnostic.args
                                } else {
                                    diagnostic.args.orEmpty() + ("points" to JsonPrimitive(points.joinToString(", ")))
                                },
                        ) to variant.id
                    }
            }.groupBy({ it.first }, { it.second })
            .flatMap { (diagnostic, variants) ->
                if (variants.size == experiment.variants.size) {
                    listOf(diagnostic)
                } else {
                    variants.map { diagnostic.copy(variant = it) }
                }
            }.let { diagnostics ->
                if (experiment.run.replications < minimumReplications) {
                    diagnostics +
                        Diagnostic(
                            CoreMessage.LINT_FEW_REPLICATIONS,
                            Severity.WARNING,
                            "Only ${experiment.run.replications} independent replications: 95% confidence intervals are unreliable; " +
                                "use at least $minimumReplications replications before comparing results",
                            experiment.origin.document,
                            experiment.origin.pointer + "/execution/replications",
                            args =
                                mapOf(
                                    "replications" to JsonPrimitive(experiment.run.replications),
                                    "minimum" to JsonPrimitive(minimumReplications),
                                ),
                        )
                } else {
                    diagnostics
                }
            }

    private fun lintGraph(graph: GraphIr): List<Diagnostic> {
        val services = graph.services.associateBy { it.path }
        val diagnostics = mutableListOf<Diagnostic>()
        val demands = mutableMapOf<String, BigDecimal>()
        val maximumRates = mutableMapOf<String, BigDecimal>()
        val queuePatience = mutableMapOf<String, QueuePatience>()
        val clientsByCall = mutableMapOf<String, MutableSet<ClientNode>>()
        val normalResponses = mutableMapOf<String, MutableMap<String, NormalResponse>>()
        val sources =
            graph.clients.flatMap { client ->
                client.classes.map { (requestClass, load) ->
                    ArrivalSource(client, requestClass, load.maximum(graph.run.warmupMs + graph.run.measurementMs))
                }
            }
        val arrivals = arrivalShares(graph, sources)
        val retryDemands = mutableMapOf<String, Fraction>()
        val retryRates = mutableMapOf<String, Fraction>()
        val retryPaths = mutableMapOf<String, MutableSet<List<CallEdge>>>()
        sources.forEach { source ->
            val client = source.client
            val requestClass = source.requestClass
            val holdingByService = mutableMapOf<String, BigDecimal>()
            val shares = arrivals.nominal.getValue(source)
            graph.entryServices(client, requestClass).forEach { entry ->
                graph.callPaths(client.copy(entry = entry.path), requestClass).forEach { calls ->
                    val outgoing = calls.associateBy { it.from }
                    val incoming = calls.associateBy { it.to }
                    val ordered = (listOf(entry.path) + calls.map { it.to }).map { services.getValue(it) }
                    ordered.forEachIndexed { index, service ->
                        val prefix = calls.take(index)
                        if ((arrivals.worst.getValue(source)[service.path] ?: Fraction.ZERO).signum() > 0 &&
                            prefix.any { it.attempts > 1 }
                        ) {
                            retryPaths.getOrPut(service.path) { linkedSetOf() }.add(prefix)
                        }
                    }
                    calls.forEach { call ->
                        clientsByCall.getOrPut(call.path) { linkedSetOf() }.add(client)
                        retryNoJitter(call)?.let(diagnostics::add)
                        timeoutBudget(call, processingMs(graph, services.getValue(call.to), requestClass), outgoing[call.to])
                            ?.let(diagnostics::add)
                    }
                    retryAmplification(calls, calls.firstOrNull())?.let(diagnostics::add)
                    deadlineBudget(client, processingMs(graph, entry, requestClass), calls.firstOrNull())?.let(diagnostics::add)
                    var holdingMs = BigDecimal.ZERO
                    ordered.asReversed().forEach { service ->
                        val outgoingNetworkMs = BigDecimal.valueOf(outgoing[service.path]?.network?.meanMs ?: 0.0) * BigDecimal.TWO
                        val downstreamMs = (holdingMs + outgoingNetworkMs).toDouble()
                        incoming[service.path]?.let { call ->
                            val processingQuantile =
                                graph.scenario(service, requestClass).filterIsInstance<ServiceStep.Process>().sumOf {
                                    quantileMs(it.processing ?: service.processing)
                                }
                            val response = NormalResponse(service.path, 2.0 * call.network.meanMs + processingQuantile + downstreamMs)
                            val byClass = normalResponses.getOrPut(call.path) { mutableMapOf() }
                            val previous = byClass[requestClass]
                            if (previous == null || response.ms > previous.ms) byClass[requestClass] = response
                        }
                        holdingMs +=
                            graph.scenario(service, requestClass).filterIsInstance<ServiceStep.Process>().sumOf {
                                BigDecimal.valueOf((it.processing ?: service.processing).meanMs)
                            } + outgoingNetworkMs
                        holdingByService[service.path] = maxOf(holdingByService[service.path] ?: BigDecimal.ZERO, holdingMs)
                        val patience =
                            incoming[service.path]?.let { QueuePatience(it.timeoutMs, it.path, false) }
                                ?: QueuePatience(client.deadlineMs, client.path, true)
                        val previous = queuePatience[service.path]
                        if (previous == null || patience.ms < previous.ms) queuePatience[service.path] = patience
                    }
                }
            }
            holdingByService.forEach { (path, holdingMs) ->
                val rate = BigDecimal.valueOf(source.maximumRate * (shares[path] ?: 0.0))
                demands[path] = (demands[path] ?: BigDecimal.ZERO) + rate * holdingMs
                maximumRates[path] = (maximumRates[path] ?: BigDecimal.ZERO) + rate
                val retryRate = arrivals.worst.getValue(source)[path] ?: Fraction.ZERO
                retryDemands[path] = (retryDemands[path] ?: Fraction.ZERO) + retryRate * Fraction.of(holdingMs)
                retryRates[path] = (retryRates[path] ?: Fraction.ZERO) + retryRate
            }
        }
        return diagnostics.distinct() + graph.calls.mapNotNull { call -> clientsByCall[call.path]?.let { timeoutUnreachable(call, it) } } +
            graph.calls.flatMap { call -> timeoutBelowLatency(call, normalResponses[call.path].orEmpty()) } +
            handlerDemand(graph.services, demands, maximumRates, queuePatience) +
            graph.services.flatMap { service ->
                retryOverload(
                    service,
                    retryDemands[service.path] ?: Fraction.ZERO,
                    retryRates[service.path] ?: Fraction.ZERO,
                    retryPaths[service.path].orEmpty(),
                    arrivals,
                )
            } +
            graph.calls
                .filter { call ->
                    call.balancing != null &&
                        graph.routers.none { it.path == call.to && it.pathSegments.last() == "#lb" }
                }.map { call ->
                    warning(
                        CoreMessage.LINT_BALANCING_IGNORED,
                        "Balancing on connection '${call.path}' has no effect because its target is not a replica group. " +
                            "Remove the setting or create target replicas; an explicit router uses its own policy.",
                        call.origin,
                        call.path,
                        "/params/balancing",
                        mapOf("connection" to JsonPrimitive(call.path)),
                    )
                } +
            graph.services.flatMap { service ->
                val used =
                    graph
                        .scenario(service)
                        .filterIsInstance<ServiceStep.Call>()
                        .map { it.edge }
                        .toSet()
                graph.outgoingCalls(service.path).filter { it.path !in used }.map { call ->
                    warning(
                        CoreMessage.LINT_SCENARIO_UNUSED,
                        "Connection '${call.path}' is absent from service '${service.path}'s scenario, so no requests use it. " +
                            "Add a call step or remove the connection.",
                        service.origin,
                        service.path,
                        "/scenario",
                        mapOf("connection" to JsonPrimitive(call.path), "service" to JsonPrimitive(service.path)),
                    )
                }
            }
    }

    /** Exact rates and ratios keep recurring routing/budget fractions intact until after threshold comparison. */
    private class Fraction private constructor(
        val numerator: BigInteger,
        val denominator: BigInteger,
    ) : Comparable<Fraction> {
        operator fun plus(other: Fraction): Fraction =
            reduced(
                numerator * other.denominator + other.numerator * denominator,
                denominator * other.denominator,
            )

        operator fun times(other: Fraction): Fraction = reduced(numerator * other.numerator, denominator * other.denominator)

        operator fun div(other: Fraction): Fraction = reduced(numerator * other.denominator, denominator * other.numerator)

        override fun compareTo(other: Fraction): Int = (numerator * other.denominator).compareTo(other.numerator * denominator)

        fun signum(): Int = numerator.signum()

        fun decimal(): BigDecimal = numerator.toBigDecimal().divide(denominator.toBigDecimal(), MathContext.DECIMAL128)

        companion object {
            val ZERO = Fraction(BigInteger.ZERO, BigInteger.ONE)
            val ONE = Fraction(BigInteger.ONE, BigInteger.ONE)

            fun of(value: Double): Fraction = of(BigDecimal.valueOf(value))

            fun of(value: BigDecimal): Fraction =
                if (value.scale() < 0) {
                    reduced(value.unscaledValue() * BigInteger.TEN.pow(-value.scale()), BigInteger.ONE)
                } else {
                    reduced(value.unscaledValue(), BigInteger.TEN.pow(value.scale()))
                }

            private fun reduced(
                numerator: BigInteger,
                denominator: BigInteger,
            ): Fraction {
                require(denominator.signum() > 0)
                if (numerator.signum() == 0) return ZERO
                val divisor = numerator.gcd(denominator)
                return Fraction(numerator / divisor, denominator / divisor)
            }
        }
    }

    private data class ArrivalSource(
        val client: ClientNode,
        val requestClass: String,
        val maximumRate: Double,
    )

    private data class ArrivalShares(
        val nominal: Map<ArrivalSource, MutableMap<String, Double>>,
        val worst: Map<ArrivalSource, MutableMap<String, Fraction>>,
        val factors: Map<String, Fraction>,
        val budgetLimited: Set<String>,
    )

    /**
     * Static shares without retries or failures. Random routers use normalized eligible weights;
     * round robin and least-in-flight assume equal conditions. As with the longest holding-path estimate,
     * common services and repeated calls contribute at most once per client and class.
     *
     * Propagate retry rates alongside the existing nominal shares, in the same topological traversal.
     * A connection's budget minimum is shared by all its client/request-type sources before router splitting.
     * Converging routes sum; repeated visits remain capped by the largest unweighted path amplification,
     * preserving the existing once-per-source convention when every connection has one attempt.
     */
    private fun arrivalShares(
        graph: GraphIr,
        sources: List<ArrivalSource>,
    ): ArrivalShares {
        val nominal = sources.associateWith { mutableMapOf(it.client.entry to 1.0) }
        val worst = sources.associateWith { mutableMapOf(it.client.entry to Fraction.of(it.maximumRate)) }
        val ceilings = sources.associateWith { mutableMapOf(it.client.entry to Fraction.of(it.maximumRate)) }
        val factors = mutableMapOf<String, Fraction>()
        val limited = mutableSetOf<String>()
        val routers = graph.routers.associateBy { it.path }
        val services = graph.services.associateBy { it.path }

        fun add(
            source: ArrivalSource,
            path: String,
            share: Double,
            rate: Fraction,
            ceiling: Fraction,
        ) {
            val shares = nominal.getValue(source)
            shares[path] = minOf(1.0, (shares[path] ?: 0.0) + share)
            val caps = ceilings.getValue(source)
            caps[path] = maxOf(caps[path] ?: Fraction.ZERO, ceiling)
            val rates = worst.getValue(source)
            rates[path] = minOf(caps.getValue(path), (rates[path] ?: Fraction.ZERO) + rate)
        }
        graph.topologicalPaths.forEach { path ->
            val router = routers[path]
            if (router != null) {
                sources.forEach { source ->
                    val outputs = graph.outgoingRoutes(path, source.requestClass)
                    val scale = outputs.maxOfOrNull { it.weight } ?: return@forEach
                    val weights = outputs.map { if (router.policy == RoutingPolicy.RANDOM) it.weight / scale else 1.0 }
                    val total = weights.sum()
                    val share = nominal.getValue(source)[path] ?: 0.0
                    val rate = worst.getValue(source)[path] ?: Fraction.ZERO
                    val ceiling = ceilings.getValue(source)[path] ?: Fraction.ZERO
                    val exactWeights = outputs.map { if (router.policy == RoutingPolicy.RANDOM) Fraction.of(it.weight) else Fraction.ONE }
                    val exactTotal = exactWeights.fold(Fraction.ZERO) { sum, weight -> sum + weight }
                    outputs.forEachIndexed { index, route ->
                        add(source, route.to, share * (weights[index] / total), rate * exactWeights[index] / exactTotal, ceiling)
                    }
                }
            } else {
                val users =
                    sources
                        .flatMap { source ->
                            graph
                                .scenario(services.getValue(path), source.requestClass)
                                .filterIsInstance<ServiceStep.Call>()
                                .distinctBy { it.edge }
                                .map { graph.call(it.edge) to source }
                        }.groupBy({ it.first }, { it.second })
                users.forEach { (call, callers) ->
                    val firstRate = callers.fold(Fraction.ZERO) { sum, source -> sum + (worst.getValue(source)[path] ?: Fraction.ZERO) }
                    val unconstrained = firstRate * Fraction.of(call.attempts.toBigDecimal())
                    val allowed =
                        call.retryBudget?.let { budget ->
                            minOf(unconstrained, firstRate * (Fraction.ONE + Fraction.of(budget.ratio)) + Fraction.of(budget.minPerMs))
                        } ?: unconstrained
                    val factor = if (firstRate.signum() == 0) Fraction.ONE else allowed / firstRate
                    factors[call.path] = factor
                    if (allowed < unconstrained) limited.add(call.path)
                    callers.forEach { source ->
                        val first = worst.getValue(source)[path] ?: Fraction.ZERO
                        add(
                            source,
                            call.to,
                            nominal.getValue(source)[path] ?: 0.0,
                            first * factor,
                            (ceilings.getValue(source)[path] ?: Fraction.ZERO) * factor,
                        )
                    }
                }
            }
        }
        return ArrivalShares(nominal, worst, factors, limited)
    }

    private data class ServiceLoad(
        val rate: Fraction,
        val holdingMs: Fraction,
        val utilization: Fraction,
    )

    /** Rate-weighted holding time and accepted occupancy; service IR already contains replica overrides. */
    private fun serviceLoad(
        service: ServiceNode,
        demand: Fraction,
        offeredRate: Fraction,
    ): ServiceLoad {
        if (offeredRate.signum() == 0) return ServiceLoad(Fraction.ZERO, Fraction.ZERO, Fraction.ZERO)
        val rate = minOf(offeredRate, service.rateLimit?.let { Fraction.of(it.ratePerMs) } ?: offeredRate)
        val holdingMs = demand / offeredRate
        return ServiceLoad(rate, holdingMs, rate * holdingMs / Fraction.of(service.handlers.toBigDecimal()))
    }

    private fun retryOverload(
        service: ServiceNode,
        demand: Fraction,
        offeredRate: Fraction,
        paths: Set<List<CallEdge>>,
        arrivals: ArrivalShares,
    ): List<Diagnostic> {
        if (service.pooler != null || offeredRate.signum() == 0) return emptyList()
        val load = serviceLoad(service, demand, offeredRate)
        if (load.utilization < Fraction.of(retryOverloadThreshold)) return emptyList()
        val chains =
            paths
                .map { calls ->
                    calls.joinToString(" × ") { "${it.path}: ${Quantities.plain(arrivals.factors.getValue(it.path).decimal())}" }
                }.distinct()
                .sorted()
                .joinToString("; ")
        val budgetLimited =
            paths
                .flatten()
                .map { it.path }
                .filter { it in arrivals.budgetLimited }
                .distinct()
                .sorted()
                .joinToString(", ")
        val rateText = Quantities.plain((load.rate * Fraction.of(BigDecimal(1_000))).decimal())
        val utilizationText = Quantities.plain(load.utilization.decimal())
        val args =
            mapOf(
                "target" to JsonPrimitive(service.path.substringBeforeLast('#', service.path)),
                "ratePerSecond" to JsonPrimitive(rateText),
                "offeredRatePerSecond" to JsonPrimitive(Quantities.plain((offeredRate * Fraction.of(BigDecimal(1_000))).decimal())),
                "utilization" to JsonPrimitive(utilizationText),
                "holdingMs" to JsonPrimitive(Quantities.plain(load.holdingMs.decimal())),
                "handlers" to JsonPrimitive(service.handlers),
                "threshold" to JsonPrimitive(number(retryOverloadThreshold)),
                "attemptChain" to JsonPrimitive(chains),
            )
        return paths.mapNotNull { it.lastOrNull { call -> call.attempts > 1 } }.distinctBy { it.path }.map { call ->
            warning(
                if (budgetLimited.isEmpty()) CoreMessage.LINT_RETRY_OVERLOAD else CoreMessage.LINT_RETRY_OVERLOAD_BUDGET,
                "Worst retry load of '${service.path}': $rateText requests/s accepted, utilization $utilizationText " +
                    "at threshold ${number(retryOverloadThreshold)}; attempts: $chains. " +
                    (if (budgetLimited.isEmpty()) "" else "Retry budgets limit connections: $budgetLimited. ") +
                    "Retries may exhaust capacity during failures; reduce attempts or load, or increase capacity.",
                call.origin,
                call.path,
                "/params/attempts",
                if (budgetLimited.isEmpty()) args else args + ("budgetLimited" to JsonPrimitive(budgetLimited)),
                replicaPath = service.path,
            )
        }
    }

    private fun processingMs(
        graph: GraphIr,
        service: ServiceNode,
        requestClass: String,
    ): Double =
        graph.scenario(service, requestClass).filterIsInstance<ServiceStep.Process>().sumOf {
            it.processing?.meanMs
                ?: service.processing.meanMs
        }

    private data class NormalResponse(
        val target: String,
        val ms: Double,
    )

    /** Target process-step quantiles plus both incoming network means and the longest downstream mean path. */
    private fun timeoutBelowLatency(
        call: CallEdge,
        responses: Map<String, NormalResponse>,
    ): List<Diagnostic> =
        responses.entries.groupBy({ it.value }, { it.key }).mapNotNull { (response, classes) ->
            if (call.timeoutMs >= response.ms) {
                null
            } else {
                val requestTypes = classes.sorted().joinToString(", ")
                val estimateText = responseNumber(response.ms, call.timeoutMs)
                warning(
                    CoreMessage.LINT_TIMEOUT_BELOW_LATENCY,
                    "Timeout ${number(call.timeoutMs)} ms on connection '${call.path}' is below the normal " +
                        "p${number(timeoutLatencyQuantile * 100.0)} response $estimateText ms of '${response.target}' " +
                        "(q=${number(timeoutLatencyQuantile)}; request types: $requestTypes). " +
                        "Timeouts may occur without failures; increase the timeout or reduce normal processing time.",
                    call.origin,
                    call.path,
                    "/params/timeout",
                    mapOf(
                        "connection" to JsonPrimitive(call.path),
                        "target" to JsonPrimitive(response.target),
                        "timeoutMs" to JsonPrimitive(number(call.timeoutMs)),
                        "estimatedMs" to JsonPrimitive(estimateText),
                        "percentile" to JsonPrimitive(number(timeoutLatencyQuantile * 100.0)),
                        "quantile" to JsonPrimitive(number(timeoutLatencyQuantile)),
                        "requestTypes" to JsonPrimitive(requestTypes),
                    ),
                )
            }
        }

    /** Rounds only an emitted estimate, adding digits until it remains visibly above its timeout. */
    private fun responseNumber(
        responseMs: Double,
        timeoutMs: Double,
    ): String {
        if (!responseMs.isFinite()) return number(responseMs)
        val exact = BigDecimal.valueOf(responseMs)
        val timeout = BigDecimal.valueOf(timeoutMs)
        var precision = 3
        var rounded = exact.round(MathContext(precision, RoundingMode.HALF_UP))
        while (rounded <= timeout) rounded = exact.round(MathContext(++precision, RoundingMode.HALF_UP))
        return Quantities.plain(rounded)
    }

    private fun quantileMs(distribution: Distribution): Double =
        when (distribution.shape) {
            DistributionShape.FIXED -> distribution.meanMs
            DistributionShape.EXPONENTIAL -> -distribution.meanMs * ln1p(-timeoutLatencyQuantile)
            DistributionShape.LOGNORMAL -> {
                // Compute ln(1 + (stdDev / mean)^2) without overflowing the ratio or its square.
                val logRatio = ln(requireNotNull(distribution.stdDevMs)) - ln(distribution.meanMs)
                val sigmaSquared =
                    if (logRatio > 0.0) 2.0 * logRatio + ln1p(exp(-2.0 * logRatio)) else ln1p(exp(2.0 * logRatio))
                if (sigmaSquared == 0.0) {
                    distribution.meanMs
                } else {
                    exp(ln(distribution.meanMs) - sigmaSquared / 2.0 + sqrt(sigmaSquared) * Normal.stdNormalInvCDF(timeoutLatencyQuantile))
                }
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
        processingMs: Double,
        next: CallEdge?,
    ): Diagnostic? {
        val required =
            2.0 * call.network.meanMs + processingMs + (next?.let { it.attempts * it.timeoutMs + maxBackoffSum(it) } ?: 0.0)
        return if (call.timeoutMs * (1.0 + timeoutBudgetTolerance) < required) {
            warning(
                CoreMessage.LINT_TIMEOUT_BUDGET,
                "Timeout ${number(call.timeoutMs)} ms is shorter than the estimated ${number(required)} ms " +
                    "for downstream processing and calls. " +
                    "Replies may arrive too late; increase this timeout or reduce downstream timeouts and retries.",
                call.origin,
                call.path,
                "/params/timeout",
                mapOf("timeoutMs" to messageNumber(call.timeoutMs), "requiredMs" to messageNumber(required)),
            )
        } else {
            null
        }
    }

    /**
     * The original client deadline bounds every attempt, including those on nested and replica calls.
     * List each affected client once even when several request types or router branches reach the call.
     */
    private fun timeoutUnreachable(
        call: CallEdge,
        clients: Set<ClientNode>,
    ): Diagnostic? {
        val affected = clients.filter { call.timeoutMs >= it.deadlineMs * timeoutUnreachableThreshold }
        if (affected.isEmpty()) return null
        val deadlines = affected.joinToString(", ") { "'${it.path}': ${number(it.deadlineMs)}" }
        return warning(
            CoreMessage.LINT_TIMEOUT_UNREACHABLE,
            "Timeout ${number(call.timeoutMs)} ms on connection '${call.path}' is at least " +
                "${number(timeoutUnreachableThreshold)} × deadline for these clients (deadlines in ms): $deadlines. " +
                "Their deadlines expire first; reduce the timeout so it can protect these requests.",
            call.origin,
            call.path,
            "/params/timeout",
            mapOf(
                "connection" to JsonPrimitive(call.path),
                // Decimal strings preserve comparison operands when localized messages format numeric arguments.
                "timeoutMs" to JsonPrimitive(number(call.timeoutMs)),
                "clientDeadlines" to JsonPrimitive(deadlines),
                "threshold" to JsonPrimitive(number(timeoutUnreachableThreshold)),
            ),
        )
    }

    /** Retry budgets limit volume, but do not stagger NONE or FIXED backoffs on applicable call paths. */
    private fun retryNoJitter(call: CallEdge): Diagnostic? {
        if (call.attempts <= retryNoJitterThreshold || call.backoff.kind == BackoffKind.EXPONENTIAL_FULL_JITTER) return null
        val backoff =
            call.backoff.kind.name
                .lowercase()
        return warning(
            CoreMessage.LINT_RETRY_NO_JITTER,
            "Connection '${call.path}' allows ${number(call.attempts.toDouble())} attempts with backoff '$backoff', " +
                "above the warning threshold of ${number(retryNoJitterThreshold.toDouble())}. " +
                "Retries may synchronize and overload dependencies; use exponential-full-jitter.",
            call.origin,
            call.path,
            "/params/backoff/kind",
            mapOf(
                "connection" to JsonPrimitive(call.path),
                "attempts" to JsonPrimitive(call.attempts),
                "backoff" to JsonPrimitive(backoff),
                "threshold" to JsonPrimitive(retryNoJitterThreshold),
            ),
        )
    }

    /**
     * Attempts include the first attempt. Multiplication is exact, including chains whose product exceeds Long.
     * Products beyond JavaScript's 53-bit exact integer range travel as digit strings.
     */
    private fun retryAmplification(
        calls: List<CallEdge>,
        firstCall: CallEdge?,
    ): Diagnostic? {
        val product = calls.fold(BigInteger.ONE) { total, call -> total * BigInteger.valueOf(call.attempts.toLong()) }
        return if (product > BigInteger.valueOf(retryAmplificationThreshold.toLong()) && firstCall != null) {
            val amplification = if (product.bitLength() <= 53) JsonPrimitive(product) else JsonPrimitive(product.toString())
            warning(
                CoreMessage.LINT_RETRY_AMPLIFICATION,
                "Nested retries allow up to $product attempts per request, above the warning threshold of $retryAmplificationThreshold. " +
                    "Failures may overload dependencies; reduce attempts at one or more layers.",
                firstCall.origin,
                firstCall.path,
                "/params/attempts",
                mapOf("amplification" to amplification, "threshold" to JsonPrimitive(retryAmplificationThreshold)),
            )
        } else {
            null
        }
    }

    /**
     * On the successful path without queueing, failures or retries, W(service) = processing mean
     * + 2 × outgoing network mean + W(next service). A leaf's W is its processing mean.
     * The service holds its handler while waiting downstream, and releases it before its own response network delay.
     * Compare handlers with the maximum client profile intensity × W: a conservative estimate before timeout truncation.
     * Sum demand from clients and classes; each source contributes its longest applicable path only once per service.
     * Use the same rate-weighted holding time to estimate full-queue waiting against the shortest caller patience.
     */
    private fun handlerDemand(
        services: List<ServiceNode>,
        demands: Map<String, BigDecimal>,
        maximumRates: Map<String, BigDecimal>,
        queuePatience: Map<String, QueuePatience>,
    ): List<Diagnostic> =
        buildList {
            services.forEach { service ->
                val demand = demands[service.path] ?: BigDecimal.ZERO
                val maximumRate = maximumRates[service.path] ?: BigDecimal.ZERO
                val holdingMs = serviceLoad(service, Fraction.of(demand), Fraction.of(maximumRate)).holdingMs.decimal().toDouble()
                if (service.pooler == null && service.handlers.toBigDecimal() < demand) {
                    val database = service.type == "database"
                    val resource = if (database) "Connections" else "Handlers"
                    add(
                        warning(
                            CoreMessage.LINT_HANDLERS_LITTLE,
                            "$resource: ${service.handlers}; estimated simultaneous demand: ${number(demand.toDouble())} at " +
                                "${number((maximumRate * BigDecimal(1_000)).toDouble())} requests/s. " +
                                "Queues may grow; increase capacity or reduce load or processing time.",
                            service.origin,
                            service.path,
                            if (database) "/params/maxConnections" else "/params/handlers",
                            mapOf(
                                "elementType" to JsonPrimitive(service.type),
                                "handlers" to JsonPrimitive(service.handlers),
                                "demand" to messageNumber(demand.toDouble()),
                                "ratePerSecond" to messageNumber((maximumRate * BigDecimal(1_000)).toDouble()),
                                "holdingMs" to messageNumber(holdingMs),
                            ),
                        ),
                    )
                }
                queueWait(service, demand, maximumRate, holdingMs, queuePatience[service.path])?.let(::add)
            }
        }

    private data class QueuePatience(
        val ms: Double,
        val source: String,
        val entry: Boolean,
    )

    /** Full-queue heuristic: queue / handlers × the same mean holding time used by Little's-law demand. */
    private fun queueWait(
        service: ServiceNode,
        demand: BigDecimal,
        maximumRate: BigDecimal,
        holdingMs: Double,
        patience: QueuePatience?,
    ): Diagnostic? {
        if (service.pooler != null || service.queueCapacity == 0 || maximumRate.signum() == 0 || patience == null) return null
        val queuedDemand = service.queueCapacity.toBigDecimal() * demand
        val capacityRate = service.handlers.toBigDecimal() * maximumRate
        val scaledLimit = BigDecimal.valueOf(patience.ms) * BigDecimal.valueOf(queueWaitThreshold)
        // Cross-multiplication preserves exact equality; dividing weighted means can introduce a false warning.
        if (queuedDemand <= scaledLimit * capacityRate) return null
        val waitMs = queuedDemand.divide(capacityRate, MathContext.DECIMAL128).toDouble()
        // Existing routing shares are Double; do not emit a warning that reports equality after conversion.
        if (waitMs.isFinite() && BigDecimal.valueOf(waitMs) <= scaledLimit) return null
        val limit = if (patience.entry) "deadline of client '${patience.source}'" else "timeout on connection '${patience.source}'"
        return warning(
            if (patience.entry) CoreMessage.LINT_QUEUE_WAIT_DEADLINE else CoreMessage.LINT_QUEUE_WAIT_TIMEOUT,
            "Full queue of '${service.path}' has estimated wait ${number(waitMs)} ms " +
                "(${service.queueCapacity} queued / ${service.handlers} slots × ${number(holdingMs)} ms holding), " +
                "above ${number(queueWaitThreshold)} × $limit ${number(patience.ms)} ms. " +
                "Queued work may outlast its caller; reduce queue capacity or processing time.",
            service.origin,
            service.path,
            "/params/queue",
            mapOf(
                "target" to JsonPrimitive(service.path.substringBeforeLast('#', service.path)),
                "estimatedMs" to JsonPrimitive(number(waitMs)),
                "limitMs" to JsonPrimitive(number(patience.ms)),
                "threshold" to JsonPrimitive(number(queueWaitThreshold)),
                "queue" to JsonPrimitive(service.queueCapacity),
                "handlers" to JsonPrimitive(service.handlers),
                "holdingMs" to JsonPrimitive(number(holdingMs)),
                (if (patience.entry) "client" else "connection") to JsonPrimitive(patience.source),
            ),
        )
    }

    /**
     * Compare the client deadline with entry processing mean + outgoing attempts × timeout + maximum backoffs.
     * The outgoing timeout already covers its network and nested calls; their budgets are not added again.
     * An entry without an outgoing call needs only its own processing. The client's request edge adds no budget.
     */
    private fun deadlineBudget(
        client: ClientNode,
        processingMs: Double,
        call: CallEdge?,
    ): Diagnostic? {
        val required = processingMs + (call?.let { it.attempts * it.timeoutMs + maxBackoffSum(it) } ?: 0.0)
        return if (client.deadlineMs < required) {
            warning(
                CoreMessage.LINT_DEADLINE_BUDGET,
                "Deadline ${number(client.deadlineMs)} ms is shorter than the entry service's estimated ${number(required)} ms. " +
                    "The client may stop waiting before completion; increase its deadline or reduce the entry call's timeout and retries.",
                client.origin,
                client.path,
                "/params/deadline",
                mapOf("deadlineMs" to messageNumber(client.deadlineMs), "requiredMs" to messageNumber(required)),
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

    private fun number(value: Double): String = if (value.isFinite()) Quantities.plain(value) else value.toString()

    private fun warning(
        code: CoreMessage,
        message: String,
        origin: Origin,
        path: String,
        suffix: String,
        args: Map<String, JsonPrimitive>,
        replicaPath: String = path,
    ): Diagnostic {
        val replica = replicaPath.substringAfterLast('#', "").toIntOrNull()
        val context =
            if (replica ==
                null
            ) {
                emptyMap()
            } else {
                mapOf("replica" to JsonPrimitive(replica), "service" to JsonPrimitive(replicaPath.substringBeforeLast('#')))
            }
        return Diagnostic(
            code,
            Severity.WARNING,
            if (replica == null) message else "Replica '$replicaPath': $message",
            origin.document,
            origin.pointer + suffix,
            path,
            args = args + context,
        )
    }
}
