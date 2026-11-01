package resiliencelab.core.compiler

import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.mapConnections

/** Expand validated service instances without introducing another execution path (ADR 0012). */
internal fun GraphIr.expandReplicaGroups(instances: Map<String, List<ServiceNode>>): GraphIr {
    val groups = instances.filterValues { it.size > 1 }

    fun target(path: String): String = if (path in groups) "$path#lb" else path
    val expandedServices =
        services.flatMap { service ->
            instances.getValue(service.path).mapIndexed { index, instance ->
                if (service.path !in groups) {
                    instance
                } else {
                    val segment = "#${index + 1}"
                    instance.copy(
                        pathSegments = service.pathSegments + segment,
                        scenario =
                            instance.scenario?.mapConnections { it + segment },
                    )
                }
            }
        }
    val expandedCalls =
        calls.flatMap { call ->
            val source = groups[call.from]
            val balancing = if (call.to in groups) call.balancing ?: RoutingPolicy.ROUND_ROBIN else call.balancing
            if (source == null) {
                listOf(call.copy(to = target(call.to), balancing = balancing))
            } else {
                source.indices.map { index ->
                    val segment = "#${index + 1}"
                    call.copy(
                        pathSegments = call.pathSegments + segment,
                        from = call.from + segment,
                        to = target(call.to),
                        balancing = balancing,
                    )
                }
            }
        }
    val generatedRouters =
        groups.toSortedMap().map { (path, copies) ->
            RouterNode(
                copies.first().pathSegments + "#lb",
                RoutingPolicy.ROUND_ROBIN,
                copies.first().origin,
                calls.firstOrNull { it.to == path }?.outlierDetection,
            )
        }
    val generatedRoutes =
        groups.toSortedMap().flatMap { (path, copies) ->
            copies.indices.map { index ->
                val segments = copies.first().pathSegments
                RouteEdge(segments + listOf("#lb", "#${index + 1}"), "$path#lb", "$path#${index + 1}", origin = copies[index].origin)
            }
        }
    return copy(
        clients = clients.map { it.copy(entry = target(it.entry)) },
        services = expandedServices,
        calls = expandedCalls,
        routers = routers + generatedRouters,
        routes = routes.map { it.copy(to = target(it.to)) } + generatedRoutes,
    )
}
