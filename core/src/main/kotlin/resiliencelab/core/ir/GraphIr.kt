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
    val arrivalRatePerMs: Double,
    val deadlineMs: Double,
    val origin: Origin = Origin.UNSPECIFIED,
) {
    /** Construct a stage-1 or hierarchical path from its slash-separated address. */
    constructor(path: String, arrivalRatePerMs: Double, deadlineMs: Double, origin: Origin = Origin.UNSPECIFIED) :
        this(path.split('/'), arrivalRatePerMs, deadlineMs, origin)

    val path: String get() = displayPath(pathSegments)
}

/** Blocking service with a bounded FIFO queue and an ordered invocation scenario. */
data class ServiceNode(
    val pathSegments: List<String>,
    val handlers: Int,
    val queueCapacity: Int,
    val processing: Distribution,
    val failureProbability: Double,
    val origin: Origin = Origin.UNSPECIFIED,
    /** Null selects processing followed by the sole outgoing call, as in stage 1. */
    val scenario: List<ServiceStep>? = null,
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
    ) : this(path.split('/'), handlers, queueCapacity, processing, failureProbability, origin, scenario)

    val path: String get() = displayPath(pathSegments)
}

/** Ordered local processing and synchronous calls of one service invocation. */
sealed interface ServiceStep {
    /** Process with the service's duration distribution and failure probability. */
    data object Process : ServiceStep

    /** Invoke the outgoing edge identified by [edge]. */
    data class Call(
        val edge: String,
    ) : ServiceStep
}

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
    ) : this(path.split('/'), from, to, network, timeoutMs, attempts, backoff, origin)

    val path: String get() = displayPath(pathSegments)
}

/** Degradation of [target] while local processing starts within [fromMs, toMs). */
data class FaultSpan(
    val targetSegments: List<String>,
    val fromMs: Double,
    val toMs: Double,
    val processingMultiplier: Double?,
    val failureProbability: Double?,
    val origin: Origin = Origin.UNSPECIFIED,
) {
    /** Construct a fault on a stage-1 or hierarchical address. */
    constructor(
        target: String,
        fromMs: Double,
        toMs: Double,
        processingMultiplier: Double?,
        failureProbability: Double?,
        origin: Origin = Origin.UNSPECIFIED,
    ) : this(target.split('/'), fromMs, toMs, processingMultiplier, failureProbability, origin)

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
 * Engine-neutral acyclic call graph of one variant (ADR 0002, ADR 0012), rooted at [client] and [entry].
 * The compiler stores services and calls in topological order, breaking ties by instance path.
 * String paths address results and diagnostics; path segments identify instances without losing boundaries.
 */
data class GraphIr(
    val client: ClientNode,
    val entry: String,
    val services: List<ServiceNode>,
    val calls: List<CallEdge>,
    val faults: List<FaultSpan>,
    val run: RunSettings,
) {
    private val servicesByPath = services.associateBy { it.path }
    private val callsByPath = calls.associateBy { it.path }
    private val outgoing = calls.groupBy { it.from }

    /** All outgoing edges in path order; no single-successor assumption. */
    fun outgoingCalls(from: String): List<CallEdge> =
        outgoing[from].orEmpty().sortedWith { left, right -> comparePaths(left.pathSegments, right.pathSegments) }

    /** Resolve a scenario's edge reference. */
    fun call(path: String): CallEdge = callsByPath.getValue(path)

    /** The stage-1 default is defined only when there is at most one outgoing call. */
    fun defaultScenario(service: ServiceNode): List<ServiceStep> {
        val edges = outgoingCalls(service.path)
        require(edges.size <= 1) { "Service '${service.path}' needs a scenario for multiple calls" }
        return listOf(ServiceStep.Process) + edges.map { ServiceStep.Call(it.path) }
    }

    /** Effective steps, also available for IR constructed directly in code. */
    fun scenario(service: ServiceNode): List<ServiceStep> = service.scenario ?: defaultScenario(service)

    /** Kahn order uses path segments to break ties and does not recurse on deep graphs. */
    val topologicalServices: List<ServiceNode> by lazy {
        val indegree = services.associate { it.path to 0 }.toMutableMap()
        calls.forEach { edge -> indegree[edge.to] = indegree.getValue(edge.to) + 1 }
        val ready =
            java.util.PriorityQueue<String> { left, right ->
                comparePaths(servicesByPath.getValue(left).pathSegments, servicesByPath.getValue(right).pathSegments)
            }
        indegree.filterValues { it == 0 }.keys.forEach(ready::add)
        val ordered =
            buildList {
                while (ready.isNotEmpty()) {
                    val path = ready.remove()
                    add(servicesByPath.getValue(path))
                    outgoing[path].orEmpty().forEach { edge ->
                        val remaining = indegree.getValue(edge.to) - 1
                        indegree[edge.to] = remaining
                        if (remaining == 0) ready.add(edge.to)
                    }
                }
            }
        require(ordered.size == services.size) { "Calls must form an acyclic graph" }
        ordered
    }

    /** Calls follow their source's topological position, then their instance path. */
    val topologicalCalls: List<CallEdge> by lazy {
        val order = topologicalServices.mapIndexed { index, node -> node.path to index }.toMap()
        calls.sortedWith(
            compareBy<CallEdge> { order.getValue(it.from) }
                .thenComparator { left, right -> comparePaths(left.pathSegments, right.pathSegments) },
        )
    }

    /** Root-to-leaf paths for the stage-1 advisory rules; branch-specific semantics remain a linter extension. */
    fun callPaths(): Sequence<List<CallEdge>> =
        sequence {
            val pending = ArrayDeque<Iterator<CallEdge>>()
            val path = mutableListOf<CallEdge>()

            fun callsFrom(node: String): List<CallEdge> =
                scenario(servicesByPath.getValue(node)).filterIsInstance<ServiceStep.Call>().map { call(it.edge) }
            pending.addLast(callsFrom(entry).iterator())
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
