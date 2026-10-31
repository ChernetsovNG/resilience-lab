package resiliencelab.core.ir

/** Shape of a duration distribution. */
enum class DistributionShape {
    FIXED,
    EXPONENTIAL,
    LOGNORMAL,
}

/** Duration distribution in milliseconds; [stdDevMs] is set for [DistributionShape.LOGNORMAL] only. */
data class Distribution(
    val shape: DistributionShape,
    val meanMs: Double,
    val stdDevMs: Double? = null,
)

/** Delay policy between attempts. */
enum class BackoffKind {
    NONE,
    FIXED,
    EXPONENTIAL_FULL_JITTER,
}

/** Backoff in milliseconds; [multiplier] grows exponential delays. */
data class Backoff(
    val kind: BackoffKind,
    val baseMs: Double,
    val maxMs: Double,
    val multiplier: Double,
)

/** Where an IR element is defined (ADR 0002, item 3): the document and the JSON pointer in it. */
data class Origin(
    val document: String,
    val pointer: String,
) {
    companion object {
        /** Origin of IR built in code rather than compiled from documents (tests, the MVP adapter). */
        val UNSPECIFIED = Origin("", "")
    }
}

/** Source of original requests; [pathSegments] is the canonical instance identity. */
data class ClientNode(
    val pathSegments: List<String>,
    val classes: Map<String, LoadProfile>,
    val deadlineMs: Double,
    val entry: String,
    val origin: Origin = Origin.UNSPECIFIED,
) {
    /** Construct a client without explicit classes for stage-1 callers. */
    constructor(pathSegments: List<String>, load: LoadProfile, deadlineMs: Double, origin: Origin = Origin.UNSPECIFIED) :
        this(pathSegments, mapOf("default" to load), deadlineMs, "", origin)

    /** Construct a stage-1 or hierarchical path from its slash-separated address. */
    constructor(path: String, arrivalRatePerMs: Double, deadlineMs: Double, origin: Origin = Origin.UNSPECIFIED) :
        this(path.split('/'), LoadProfile.constant(arrivalRatePerMs), deadlineMs, origin)

    val path: String get() = displayPath(pathSegments)

    /** Sum of class intensities; a single profile retains its exact points. */
    val load: LoadProfile
        get() {
            if (classes.size == 1) return classes.values.single()
            val times =
                classes.values
                    .flatMap { it.points }
                    .map { it.timeMs }
                    .distinct()
                    .sorted()
            return LoadProfile(times.map { time -> LoadPoint(time, classes.values.sumOf { it.rateAt(time) }) })
        }
}

/** Transaction server pool; the executable node's handlers are the client connection limit, with no client queue. */
data class PoolerSettings(
    val poolSize: Int,
    val waitTimeoutMs: Double,
)

/**
 * Blocking service with a bounded FIFO queue and an ordered invocation scenario.
 * A database shares this runtime shape: handlers are connections, processing is query execution,
 * and its scenario contains only processing because the compiler forbids outgoing connections.
 */
data class ServiceNode(
    val pathSegments: List<String>,
    val handlers: Int,
    val queueCapacity: Int,
    val processing: Distribution,
    val failureProbability: Double,
    val origin: Origin = Origin.UNSPECIFIED,
    /** Null selects processing followed by outgoing calls in path order. */
    val scenario: List<ServiceStep>? = null,
    val pooler: PoolerSettings? = null,
    /** Catalog type retained for resource names in results; runtime service semantics remain shared. */
    val type: String = "service",
    val rateLimit: RateLimitConfig? = null,
    val healthCheck: HealthCheckConfig? = null,
) {
    /** Construct a stage-1 or hierarchical path from its slash-separated address. */
    constructor(
        path: String,
        handlers: Int,
        queueCapacity: Int,
        processing: Distribution,
        failureProbability: Double,
        origin: Origin = Origin.UNSPECIFIED,
        scenario: List<ServiceStep>? = null,
        pooler: PoolerSettings? = null,
        type: String = "service",
        rateLimit: RateLimitConfig? = null,
        healthCheck: HealthCheckConfig? = null,
    ) : this(
        path.split('/'),
        handlers,
        queueCapacity,
        processing,
        failureProbability,
        origin,
        scenario,
        pooler,
        type,
        rateLimit,
        healthCheck,
    )

    val path: String get() = displayPath(pathSegments)
}

/** Ordered local processing and synchronous calls of one service invocation. */
sealed interface ServiceStep {
    /** Null applies to every request class. */
    val classes: Set<String>?

    /** Omitted processing and failure probability use the effective service parameters. */
    data class Process(
        val processing: Distribution? = null,
        val failureProbability: Double? = null,
        override val classes: Set<String>? = null,
    ) : ServiceStep

    /** Invoke the outgoing edge identified by [edge]. */
    data class Call(
        val edge: String,
        override val classes: Set<String>? = null,
    ) : ServiceStep
}

/** Per-caller connection slots; acquisition consumes deadline time, before the attempt timeout starts. */
data class CallPool(
    val size: Int,
    val acquireTimeoutMs: Double = 30_000.0,
)

/** Synchronous call from [from] to [to], addressed by its instance path. */
data class CallEdge(
    val pathSegments: List<String>,
    val from: String,
    val to: String,
    val network: Distribution,
    val timeoutMs: Double,
    val attempts: Int,
    val backoff: Backoff,
    val origin: Origin = Origin.UNSPECIFIED,
    val retryTarget: RetryTarget = RetryTarget.ANY,
    /** Explicit incoming policy, applied only when the target is a generated replica router. */
    val balancing: RoutingPolicy? = null,
    val pool: CallPool? = null,
    val circuitBreaker: CircuitBreakerConfig? = null,
    val retryBudget: RetryBudgetConfig? = null,
    val fallback: FallbackConfig? = null,
    val outlierDetection: OutlierDetectionConfig? = null,
) {
    /** Construct a stage-1 or hierarchical path from its slash-separated address. */
    constructor(
        path: String,
        from: String,
        to: String,
        network: Distribution,
        timeoutMs: Double,
        attempts: Int,
        backoff: Backoff,
        origin: Origin = Origin.UNSPECIFIED,
        retryTarget: RetryTarget = RetryTarget.ANY,
        balancing: RoutingPolicy? = null,
        pool: CallPool? = null,
        circuitBreaker: CircuitBreakerConfig? = null,
        retryBudget: RetryBudgetConfig? = null,
        fallback: FallbackConfig? = null,
        outlierDetection: OutlierDetectionConfig? = null,
    ) : this(
        path.split('/'),
        from,
        to,
        network,
        timeoutMs,
        attempts,
        backoff,
        origin,
        retryTarget,
        balancing,
        pool,
        circuitBreaker,
        retryBudget,
        fallback,
        outlierDetection,
    )

    val path: String get() = displayPath(pathSegments)
}

/** Whether retries may reuse an output before the other outputs have been tried. */
enum class RetryTarget { ANY, OTHER }

/** Stateless routing policies; ties use route instance-path order. */
enum class RoutingPolicy { ROUND_ROBIN, RANDOM, LEAST_IN_FLIGHT }

/** A zero-delay selector with its own counter and path-addressed routing source. */
data class RouterNode(
    val pathSegments: List<String>,
    val policy: RoutingPolicy,
    val origin: Origin = Origin.UNSPECIFIED,
    val outlierDetection: OutlierDetectionConfig? = null,
) {
    constructor(
        path: String,
        policy: RoutingPolicy,
        origin: Origin = Origin.UNSPECIFIED,
        outlierDetection: OutlierDetectionConfig? = null,
    ) : this(path.split('/'), policy, origin, outlierDetection)

    val path: String get() = displayPath(pathSegments)
}

/** An output of a router; weight affects only random selection, never adds delay or retries. */
data class RouteEdge(
    val pathSegments: List<String>,
    val from: String,
    val to: String,
    val weight: Double = 1.0,
    val origin: Origin = Origin.UNSPECIFIED,
    val classes: Set<String>? = null,
) {
    constructor(
        path: String,
        from: String,
        to: String,
        weight: Double = 1.0,
        origin: Origin = Origin.UNSPECIFIED,
        classes: Set<String>? = null,
    ) : this(path.split('/'), from, to, weight, origin, classes)

    val path: String get() = displayPath(pathSegments)
}

/** Effects available on executable blocks and connections; capacity loss requires a slot pool. */
enum class FaultKind { SLOWDOWN, ERRORS, UNAVAILABLE, BLACKHOLE, CAPACITY_LOSS }

/**
 * A degradation active during [fromMs, toMs). Overlaps multiply slowdown factors, add delays,
 * combine error probabilities as independent events and choose the minimum capacity.
 * Active error faults replace the target's normal failure probability.
 */
data class FaultSpan(
    val targetSegments: List<String>,
    val fromMs: Double,
    val toMs: Double,
    val kind: FaultKind,
    val multiplier: Double = 1.0,
    val delayMs: Double = 0.0,
    val failureProbability: Double? = null,
    val capacity: Int? = null,
    val origin: Origin = Origin.UNSPECIFIED,
) {
    /** Construct a fault on a stage-1 or hierarchical address. */
    constructor(
        target: String,
        fromMs: Double,
        toMs: Double,
        kind: FaultKind,
        multiplier: Double = 1.0,
        delayMs: Double = 0.0,
        failureProbability: Double? = null,
        capacity: Int? = null,
        origin: Origin = Origin.UNSPECIFIED,
    ) : this(target.split('/'), fromMs, toMs, kind, multiplier, delayMs, failureProbability, capacity, origin)

    val target: String get() = displayPath(targetSegments)
}

/** Instance suffixes remain separate identity segments but display as `service#2` (ADR 0012). */
private fun displayPath(segments: List<String>): String =
    buildString {
        segments.forEachIndexed { index, segment ->
            if (index > 0 && !segment.startsWith("#")) append('/')
            append(segment)
        }
    }

/** Lexicographic segment order, including a parent path before paths that extend it. */
private fun comparePaths(
    left: List<String>,
    right: List<String>,
): Int {
    for (index in 0 until minOf(left.size, right.size)) {
        val result = left[index].compareTo(right[index])
        if (result != 0) return result
    }
    return left.size.compareTo(right.size)
}

/** Replications, measurement window, seed and real-time cap of a run. */
data class RunSettings(
    val replications: Int,
    val warmupMs: Double,
    val measurementMs: Double,
    val seed: Long,
    val maxRealTimeSeconds: Long,
    val windowMs: Double = measurementMs / 100.0,
)

/**
 * Engine-neutral acyclic call graph of one variant (ADR 0002, ADR 0012), rooted at the inputs in [clients].
 * The compiler stores services and calls in topological order, breaking ties by instance path.
 * String paths address results and diagnostics; path segments identify instances without losing boundaries.
 */
data class GraphIr(
    val clients: List<ClientNode>,
    val services: List<ServiceNode>,
    val calls: List<CallEdge>,
    val faults: List<FaultSpan>,
    val run: RunSettings,
    val routers: List<RouterNode> = emptyList(),
    val routes: List<RouteEdge> = emptyList(),
) {
    /** Source-level adapter for hand-built single-client IR. */
    constructor(
        client: ClientNode,
        entry: String,
        services: List<ServiceNode>,
        calls: List<CallEdge>,
        faults: List<FaultSpan>,
        run: RunSettings,
        routers: List<RouterNode> = emptyList(),
        routes: List<RouteEdge> = emptyList(),
    ) : this(listOf(client.copy(entry = entry)), services, calls, faults, run, routers, routes)

    /** Convenience accessors for callers constructing single-client IR. */
    val client: ClientNode get() = clients.single()
    val entry: String get() = client.entry

    /** Request-class identifiers shared by all inputs. */
    val classes: Set<String> get() = clients.flatMap { it.classes.keys }.toSortedSet()

    private val servicesByPath = services.associateBy { it.path }
    private val callsByPath = calls.associateBy { it.path }
    private val outgoing = calls.groupBy { it.from }
    private val routing = routes.groupBy { it.from }

    /** Router outputs in deterministic instance-path order. */
    fun outgoingRoutes(
        from: String,
        requestClass: String? = null,
    ): List<RouteEdge> =
        routing[from].orEmpty().filter { requestClass == null || it.classes == null || requestClass in it.classes }.sortedWith {
            left,
            right,
            ->
            comparePaths(left.pathSegments, right.pathSegments)
        }

    /** Leaf services reachable through every input's zero-delay replica routers. */
    val entryServices: List<ServiceNode> get() = clients.flatMap { entryServices(it) }.distinctBy { it.path }

    /** Leaf services reached by one client and, optionally, one request class. */
    fun entryServices(
        client: ClientNode,
        requestClass: String? = null,
    ): List<ServiceNode> {
        val pending = ArrayDeque<String>()
        val visited = mutableSetOf<String>()
        pending.add(client.entry)
        return buildList {
            while (pending.isNotEmpty()) {
                val path = pending.removeFirst()
                if (!visited.add(path)) continue
                val service = servicesByPath[path]
                if (service != null) add(service) else outgoingRoutes(path, requestClass).forEach { pending.addLast(it.to) }
            }
        }
    }

    /** All outgoing edges in path order; no single-successor assumption. */
    fun outgoingCalls(from: String): List<CallEdge> =
        outgoing[from].orEmpty().sortedWith { left, right -> comparePaths(left.pathSegments, right.pathSegments) }

    /** Resolve a scenario's edge reference. */
    fun call(path: String): CallEdge = callsByPath.getValue(path)

    /** Processing followed by outgoing calls in path order; documents with multiple calls require an explicit scenario. */
    fun defaultScenario(service: ServiceNode): List<ServiceStep> {
        val edges = outgoingCalls(service.path)
        return listOf(ServiceStep.Process()) + edges.map { ServiceStep.Call(it.path) }
    }

    /** Effective steps, also available for IR constructed directly in code. */
    fun scenario(
        service: ServiceNode,
        requestClass: String? = null,
    ): List<ServiceStep> =
        (service.scenario ?: defaultScenario(service)).filter { requestClass == null || it.classes == null || requestClass in it.classes!! }

    /** Kahn order uses path segments to break ties and does not recurse on deep graphs. */
    val topologicalPaths: List<String> by lazy {
        val paths = services.associate { it.path to it.pathSegments } + routers.associate { it.path to it.pathSegments }
        val edges = calls.map { it.from to it.to } + routes.map { it.from to it.to }
        val successors = edges.groupBy({ it.first }, { it.second })
        val indegree = paths.keys.associateWith { 0 }.toMutableMap()
        edges.forEach { (_, to) -> indegree[to] = indegree.getValue(to) + 1 }
        val ready =
            java.util.PriorityQueue<String> { left, right ->
                comparePaths(paths.getValue(left), paths.getValue(right))
            }
        indegree.filterValues { it == 0 }.keys.forEach(ready::add)
        val ordered =
            buildList {
                while (ready.isNotEmpty()) {
                    val path = ready.remove()
                    add(path)
                    successors[path].orEmpty().forEach { target ->
                        val remaining = indegree.getValue(target) - 1
                        indegree[target] = remaining
                        if (remaining == 0) ready.add(target)
                    }
                }
            }
        require(ordered.size == paths.size) { "Calls must form an acyclic graph" }
        ordered
    }

    /** Service runtimes follow the same order as the complete graph. */
    val topologicalServices: List<ServiceNode> by lazy { topologicalPaths.mapNotNull(servicesByPath::get) }

    /** Calls follow their source's topological position, then their instance path. */
    val topologicalCalls: List<CallEdge> by lazy {
        val order = topologicalPaths.withIndex().associate { it.value to it.index }
        calls.sortedWith(
            compareBy<CallEdge> { order.getValue(it.from) }
                .thenComparator { left, right -> comparePaths(left.pathSegments, right.pathSegments) },
        )
    }

    /** Root-to-leaf paths for the stage-1 advisory rules; branch-specific semantics remain a linter extension. */
    fun callPaths(): Sequence<List<CallEdge>> =
        clients.asSequence().flatMap { client ->
            client.classes.keys
                .asSequence()
                .flatMap { callPaths(client, it) }
        }

    /** Paths reachable by this client and class, following only applicable steps and routes. */
    fun callPaths(
        client: ClientNode,
        requestClass: String,
    ): Sequence<List<CallEdge>> =
        entryServices(client, requestClass).asSequence().flatMap { root ->
            sequence {
                val pending = ArrayDeque<Iterator<CallEdge>>()
                val path = mutableListOf<CallEdge>()

                fun callsFrom(node: String): List<CallEdge> =
                    scenario(servicesByPath.getValue(node), requestClass).filterIsInstance<ServiceStep.Call>().flatMap { step ->
                        val edge = call(step.edge)
                        val targets = ArrayDeque<String>()
                        targets.add(edge.to)
                        buildList {
                            while (targets.isNotEmpty()) {
                                val target = targets.removeFirst()
                                if (target in servicesByPath) {
                                    add(if (target == edge.to) edge else edge.copy(to = target))
                                } else {
                                    outgoingRoutes(target, requestClass).forEach { targets.addLast(it.to) }
                                }
                            }
                        }
                    }
                pending.addLast(callsFrom(root.path).iterator())
                if (!pending.last().hasNext()) yield(emptyList())
                while (pending.isNotEmpty()) {
                    val edges = pending.last()
                    if (!edges.hasNext()) {
                        pending.removeLast()
                        if (path.isNotEmpty()) path.removeAt(path.lastIndex)
                        continue
                    }
                    val edge = edges.next()
                    path.add(edge)
                    val next = callsFrom(edge.to)
                    if (next.isEmpty()) {
                        yield(path.toList())
                        path.removeAt(path.lastIndex)
                    } else {
                        pending.addLast(next.iterator())
                    }
                }
            }
        }
}
