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
import java.math.BigInteger
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.ln1p
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Advisory checks on valid, compiled paths from the client (stage-1 design §3.4).
 * Durations use milliseconds and arrival rates use requests per millisecond, as in the engine.
 * These static estimates omit queueing and degradation; distribution means cannot bound random tails.
 * [minimumReplications] is the positive threshold for the experiment-wide confidence-interval warning.
 * [retryNoJitterThreshold] is the attempt count above which NONE and FIXED backoffs warn (1 by default).
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
) {
    init {
        require(retryAmplificationThreshold >= 1) { "retryAmplificationThreshold must be at least 1" }
        require(retryNoJitterThreshold >= 1) { "retryNoJitterThreshold must be at least 1" }
        require(minimumReplications >= 1) { "minimumReplications must be at least 1" }
        require(timeoutBudgetTolerance.isFinite() && timeoutBudgetTolerance >= 0.0) {
            "timeoutBudgetTolerance must be finite and non-negative"
        }
        require(timeoutUnreachableThreshold.isFinite() && timeoutUnreachableThreshold >= 1.0) {
            "timeoutUnreachableThreshold must be finite and at least 1"
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
        val demands = mutableMapOf<String, Double>()
        val maximumRates = mutableMapOf<String, Double>()
        val clientsByCall = mutableMapOf<String, MutableSet<ClientNode>>()
        val normalResponses = mutableMapOf<String, MutableMap<String, NormalResponse>>()
        graph.clients.forEach { client ->
            client.classes.forEach { (requestClass, load) ->
                val holdingByService = mutableMapOf<String, Double>()
                val shares = arrivalShares(graph, client, requestClass)
                graph.entryServices(client, requestClass).forEach { entry ->
                    graph.callPaths(client.copy(entry = entry.path), requestClass).forEach { calls ->
                        val outgoing = calls.associateBy { it.from }
                        val incoming = calls.associateBy { it.to }
                        val ordered = (listOf(entry.path) + calls.map { it.to }).map { services.getValue(it) }
                        calls.forEach { call ->
                            clientsByCall.getOrPut(call.path) { linkedSetOf() }.add(client)
                            retryNoJitter(call)?.let(diagnostics::add)
                            timeoutBudget(call, processingMs(graph, services.getValue(call.to), requestClass), outgoing[call.to])
                                ?.let(diagnostics::add)
                        }
                        retryAmplification(calls, calls.firstOrNull())?.let(diagnostics::add)
                        deadlineBudget(client, processingMs(graph, entry, requestClass), calls.firstOrNull())?.let(diagnostics::add)
                        var holdingMs = 0.0
                        ordered.asReversed().forEach { service ->
                            val outgoingNetworkMs = 2.0 * (outgoing[service.path]?.network?.meanMs ?: 0.0)
                            val downstreamMs = holdingMs + outgoingNetworkMs
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
                            holdingMs += processingMs(graph, service, requestClass) + outgoingNetworkMs
                            holdingByService[service.path] = maxOf(holdingByService[service.path] ?: 0.0, holdingMs)
                        }
                    }
                }
                val maximumRate = load.maximum(graph.run.warmupMs + graph.run.measurementMs)
                holdingByService.forEach { (path, holdingMs) ->
                    val rate = maximumRate * (shares[path] ?: 0.0)
                    demands[path] = (demands[path] ?: 0.0) + rate * holdingMs
                    maximumRates[path] = (maximumRates[path] ?: 0.0) + rate
                }
            }
        }
        return diagnostics.distinct() + graph.calls.mapNotNull { call -> clientsByCall[call.path]?.let { timeoutUnreachable(call, it) } } +
            graph.calls.flatMap { call -> timeoutBelowLatency(call, normalResponses[call.path].orEmpty()) } +
            handlerDemand(graph.services, demands, maximumRates) +
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

    /**
     * Static shares without retries or failures. Random routers use normalized eligible weights;
     * round robin and least-in-flight assume equal conditions. As with the longest holding-path estimate,
     * common services and repeated calls contribute at most once per client and class.
     */
    private fun arrivalShares(
        graph: GraphIr,
        client: ClientNode,
        requestClass: String,
    ): Map<String, Double> {
        val shares = mutableMapOf(client.entry to 1.0)
        val routers = graph.routers.associateBy { it.path }
        val services = graph.services.associateBy { it.path }

        fun add(
            path: String,
            share: Double,
        ) {
            shares[path] = minOf(1.0, (shares[path] ?: 0.0) + share)
        }
        graph.topologicalPaths.forEach { path ->
            val share = shares[path] ?: 0.0
            val router = routers[path]
            if (router != null) {
                val outputs = graph.outgoingRoutes(path, requestClass)
                val scale = outputs.maxOfOrNull { it.weight } ?: return@forEach
                val weights = outputs.map { if (router.policy == RoutingPolicy.RANDOM) it.weight / scale else 1.0 }
                val total = weights.sum()
                outputs.zip(weights).forEach { (route, weight) -> add(route.to, share * (weight / total)) }
            } else {
                graph
                    .scenario(services.getValue(path), requestClass)
                    .filterIsInstance<ServiceStep.Call>()
                    .distinctBy { it.edge }
                    .forEach { add(graph.call(it.edge).to, share) }
            }
        }
        return shares
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
                warning(
                    CoreMessage.LINT_TIMEOUT_BELOW_LATENCY,
                    "Timeout ${number(call.timeoutMs)} ms on connection '${call.path}' is below the normal " +
                        "p${number(timeoutLatencyQuantile * 100.0)} response ${number(response.ms)} ms of '${response.target}' " +
                        "(q=${number(timeoutLatencyQuantile)}; request types: $requestTypes). " +
                        "Timeouts may occur without failures; increase the timeout or reduce normal processing time.",
                    call.origin,
                    call.path,
                    "/params/timeout",
                    mapOf(
                        "connection" to JsonPrimitive(call.path),
                        "target" to JsonPrimitive(response.target),
                        "timeoutMs" to JsonPrimitive(number(call.timeoutMs)),
                        "estimatedMs" to JsonPrimitive(number(response.ms)),
                        "percentile" to JsonPrimitive(number(timeoutLatencyQuantile * 100.0)),
                        "quantile" to JsonPrimitive(number(timeoutLatencyQuantile)),
                        "requestTypes" to JsonPrimitive(requestTypes),
                    ),
                )
            }
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
     */
    private fun handlerDemand(
        services: List<ServiceNode>,
        demands: Map<String, Double>,
        maximumRates: Map<String, Double>,
    ): List<Diagnostic> =
        buildList {
            services.forEach { service ->
                val demand = demands[service.path] ?: 0.0
                val maximumRate = maximumRates[service.path] ?: 0.0
                val holdingMs = if (maximumRate == 0.0) 0.0 else demand / maximumRate
                if (service.pooler == null && service.handlers < demand) {
                    val database = service.type == "database"
                    val resource = if (database) "Connections" else "Handlers"
                    add(
                        warning(
                            CoreMessage.LINT_HANDLERS_LITTLE,
                            "$resource: ${service.handlers}; estimated simultaneous demand: ${number(demand)} at " +
                                "${number(maximumRate * 1_000.0)} requests/s. " +
                                "Queues may grow; increase capacity or reduce load or processing time.",
                            service.origin,
                            service.path,
                            if (database) "/params/maxConnections" else "/params/handlers",
                            mapOf(
                                "elementType" to JsonPrimitive(service.type),
                                "handlers" to JsonPrimitive(service.handlers),
                                "demand" to messageNumber(demand),
                                "ratePerSecond" to messageNumber(maximumRate * 1_000.0),
                                "holdingMs" to messageNumber(holdingMs),
                            ),
                        ),
                    )
                }
            }
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
    ): Diagnostic {
        val replica = path.substringAfterLast('#', "").toIntOrNull()
        val context =
            if (replica ==
                null
            ) {
                emptyMap()
            } else {
                mapOf("replica" to JsonPrimitive(replica), "service" to JsonPrimitive(path.substringBeforeLast('#')))
            }
        return Diagnostic(
            code,
            Severity.WARNING,
            if (replica == null) message else "Replica '$path': $message",
            origin.document,
            origin.pointer + suffix,
            path,
            args = args + context,
        )
    }
}
