package resiliencelab.core.engine.ksl

import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy

/** One router's counter, path-addressed random source and unfinished work per output, including orphaned work. */
internal class RouterRuntime(
    node: RouterNode,
    private val outputs: List<RouteEdge>,
    streams: StreamSource,
) {
    private val defaultPolicy = node.policy
    val isReplicaGroup = node.pathSegments.last() == "#lb"
    private val random by lazy { streams.stream(node.pathSegments, StreamRole.ROUTING) }
    private val inFlight = outputs.associate { it.path to 0 }.toMutableMap()
    private var cursor = 0

    init {
        require(outputs.isNotEmpty()) { "Router '${node.path}' has no outputs" }
        require(outputs.all { it.weight.isFinite() && it.weight > 0.0 }) { "Route weights must be finite and positive" }
    }

    fun reset() {
        cursor = 0
        inFlight.replaceAll { _, _ -> 0 }
    }

    fun select(
        tried: Set<String>,
        policy: RoutingPolicy = defaultPolicy,
        requestClass: String = "default",
    ): RouteEdge? {
        val applicable = outputs.filter { it.classes == null || requestClass in it.classes }
        if (applicable.isEmpty()) return null
        val eligible = applicable.filterNot { it.path in tried }.ifEmpty { applicable }
        val selected =
            when (policy) {
                RoutingPolicy.ROUND_ROBIN -> {
                    while (outputs[cursor] !in eligible) cursor = (cursor + 1) % outputs.size
                    outputs[cursor].also { cursor = (cursor + 1) % outputs.size }
                }
                RoutingPolicy.RANDOM -> {
                    val scale = eligible.maxOf { it.weight }
                    val total = eligible.sumOf { it.weight / scale }
                    var remaining = random.randU01() * total
                    eligible.firstOrNull {
                        remaining -= it.weight / scale
                        remaining < 0.0
                    } ?: eligible.last()
                }
                RoutingPolicy.LEAST_IN_FLIGHT -> eligible.minBy { inFlight.getValue(it.path) }
            }
        inFlight[selected.path] = inFlight.getValue(selected.path) + 1
        return selected
    }

    fun complete(route: RouteEdge) {
        val remaining = inFlight.getValue(route.path) - 1
        check(remaining >= 0) { "Unbalanced route '${route.path}'" }
        inFlight[route.path] = remaining
    }
}
