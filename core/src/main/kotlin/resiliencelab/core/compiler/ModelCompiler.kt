package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Dimension
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.ParamKind
import resiliencelab.core.catalog.Quantities
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.catalog.TypeCategory
import resiliencelab.core.document.ConnectionInstance
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.GridAxis
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.ScenarioStep
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.CircuitBreakerConfig
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FallbackConfig
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.HealthCheckConfig
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.OutlierDetectionConfig
import resiliencelab.core.ir.PoolerSettings
import resiliencelab.core.ir.RateLimitConfig
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import resiliencelab.core.ir.WindowCountException
import resiliencelab.core.ir.WindowGridFailure
import resiliencelab.core.ir.windowCount
import kotlin.math.ceil

/** One compiled variant, containing points in first-axis-outermost order. */
data class CompiledVariant(
    val id: String,
    val label: String,
    val points: List<CompiledPoint>,
)

/** One effective model after variant and grid overrides; coordinates retain their original units. */
data class CompiledPoint(
    val id: String,
    val coordinates: Map<String, JsonElement>,
    val graph: GraphIr,
    /** Source locations of explicit overrides, keyed by element.parameter. */
    val parameterOrigins: Map<String, Origin> = emptyMap(),
)

/** All variants of an experiment with shared run settings. */
data class CompiledExperiment(
    val variants: List<CompiledVariant>,
    val run: RunSettings,
    val grid: List<GridAxis> = emptyList(),
    /** Source document for experiment-wide diagnostics; unspecified for experiments built in code. */
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Compiler output: an experiment when there are no errors, and all diagnostics. */
data class CompileResult(
    val experiment: CompiledExperiment?,
    val diagnostics: List<Diagnostic>,
)

/**
 * Compiles a model and an experiment into one graph IR per variant and grid point (ADR 0002; stage 1 design §3–4):
 * variant overrides and then grid values are applied by path, parameters are read against the catalog and the call graph topology —
 * one request per client, class-restricted paths, reachable services and no cycles — is checked.
 */
class ModelCompiler(
    private val catalog: Catalog = Stage1Catalog.catalog,
) {
    fun compile(
        model: ModelFile,
        modelDocument: String,
        experiment: ExperimentFile,
        experimentDocument: String,
    ): CompileResult {
        val sink = Diagnostics()
        val structureOk = checkStructure(model, modelDocument, sink)
        val run = runSettings(experiment, experimentDocument, sink)
        val faultSpans = faults(experiment, model, experimentDocument, sink, run)
        checkVariants(experiment, experimentDocument, sink)
        val points = gridPoints(experiment, experimentDocument, sink)
        val variants =
            experiment.variants.mapIndexed { index, variant ->
                val overrides =
                    variant.overrides.toSortedMap().map { (path, value) ->
                        ParameterPatch(path, value, JsonPointer.of("variants", index, "overrides", path))
                    }
                val compiled =
                    points.mapIndexedNotNull { pointIndex, point ->
                        val patched = applyOverrides(model, overrides + point, variant.id, experimentDocument, sink)
                        val parts =
                            buildGraph(patched.model, modelDocument, patched.origins, sink, structureOk, run)
                                ?: return@mapIndexedNotNull null
                        run?.let {
                            val expanded =
                                GraphIr(
                                    parts.clients,
                                    parts.services,
                                    parts.calls,
                                    emptyList(),
                                    it,
                                    parts.routers,
                                    parts.routes,
                                ).let { graph -> expandReplicas(graph, patched.model, modelDocument, patched.origins, sink) }
                            val graph =
                                expanded.copy(
                                    services = expanded.topologicalServices.map { node -> node.copy(scenario = expanded.scenario(node)) },
                                    calls = expanded.topologicalCalls,
                                    faults = bindFaults(faultSpans, expanded, sink, variant.id),
                                )
                            CompiledPoint(
                                "p$pointIndex",
                                point.associate { it.path to it.value },
                                graph,
                                parameterOrigins(graph, patched, modelDocument),
                            )
                        }
                    }
                CompiledVariant(variant.id, variant.label ?: variant.id, compiled)
            }
        val diagnostics = sink.items.distinct()
        val failed = diagnostics.any { it.severity == Severity.ERROR } || run == null
        return CompileResult(
            if (failed) null else CompiledExperiment(variants, run, experiment.grid, Origin(experimentDocument, "")),
            diagnostics,
        )
    }

    /** A variant's model and, per element, where its overridden values come from. */
    private class Patched(
        val model: ModelFile,
        val origins: Map<String, OverrideOrigins>,
    )

    /** Instance paths inherit variant/grid locations; replica patches take precedence over inherited values. */
    private fun parameterOrigins(
        graph: GraphIr,
        patched: Patched,
        document: String,
    ): Map<String, Origin> =
        buildMap {
            val elements =
                graph.services.map { it.pathSegments.first() to it.path } + graph.calls.map { it.pathSegments.first() to it.path }
            patched.origins.forEach { (path, origins) ->
                val paths = (listOf(path) + elements.filter { it.first == path }.map { it.second }).distinct()
                origins.pointers.forEach { (parameter, pointer) ->
                    paths.forEach { put("$it.$parameter", Origin(origins.document, pointer)) }
                }
            }

            fun replicaParameters(
                path: String,
                values: JsonObject,
                pointer: String,
                prefix: String = "",
            ) {
                values.forEach { (name, value) ->
                    val parameter = if (prefix.isEmpty()) name else "$prefix.$name"
                    val source = JsonPointer.child(pointer, name)
                    put("$path.$parameter", Origin(document, source))
                    if (value is JsonObject) replicaParameters(path, value, source, parameter)
                }
            }
            graph.services.forEach { instance ->
                val group = instance.pathSegments.first()
                val number =
                    instance.pathSegments
                        .last()
                        .removePrefix("#")
                        .toIntOrNull() ?: 1
                patched.model.blocks[group]?.replicaOverrides?.get(number.toString())?.let { params ->
                    replicaParameters(instance.path, params, JsonPointer.of("blocks", group, "replicaOverrides", number))
                }
            }
        }

    private data class ParameterPatch(
        val path: String,
        val value: JsonElement,
        val pointer: String,
        val pathPointer: String = pointer,
    )

    private fun gridPoints(
        experiment: ExperimentFile,
        document: String,
        sink: Diagnostics,
    ): List<List<ParameterPatch>> {
        if (experiment.grid.size > 2) {
            sink.error(CoreMessage.GRID_AXES, "A grid must contain one or two axes", document, "/grid")
            return emptyList()
        }
        val paths = mutableListOf<String>()
        experiment.grid.forEachIndexed { index, axis ->
            if (axis.values.isEmpty()) {
                sink.error(CoreMessage.GRID_VALUES, "A grid axis must contain at least one value", document, "/grid/$index/values")
            }
            if (paths.any { it == axis.path || it.startsWith("${axis.path}.") || axis.path.startsWith("$it.") }) {
                sink.error(CoreMessage.GRID_PATH_OVERLAP, "Grid axis paths must not overlap", document, "/grid/$index/path")
            }
            paths += axis.path
        }
        return experiment.grid.fold(listOf(emptyList())) { points, axis ->
            val index = paths.indexOf(axis.path)
            points.flatMap { point ->
                axis.values.mapIndexed { valueIndex, value ->
                    point + ParameterPatch(axis.path, value, "/grid/$index/values/$valueIndex", "/grid/$index/path")
                }
            }
        }
    }

    private class GraphParts(
        val clients: List<ClientNode>,
        val services: List<ServiceNode>,
        val calls: List<CallEdge>,
        val routers: List<RouterNode>,
        val routes: List<RouteEdge>,
    )

    private fun checkStructure(
        model: ModelFile,
        document: String,
        sink: Diagnostics,
    ): Boolean {
        val before = sink.errorCount()
        model.blocks.forEach { (id, block) ->
            val pointer = JsonPointer.of("blocks", id)
            if (!ID.matches(id)) {
                sink.error(
                    CoreMessage.ID_BLOCK,
                    "Block id '$id' must match ${ID.pattern}",
                    document,
                    pointer,
                    id,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(id),
                            "pattern" to JsonPrimitive(ID.pattern),
                        ),
                )
            }
            val type = catalog.type(block.type)
            if (block.scenario != null && block.type != "service") {
                sink.error(CoreMessage.SCENARIO_BLOCK, "Only service blocks may define a scenario", document, "$pointer/scenario", id)
            }
            if (block.replicaOverrides.orEmpty().isNotEmpty() && block.type != "service") {
                sink.error(
                    CoreMessage.REPLICA_BLOCK,
                    "Only service blocks may define replicaOverrides",
                    document,
                    "$pointer/replicaOverrides",
                    id,
                )
            }
            if (type == null || type.category != TypeCategory.BLOCK) {
                sink.error(
                    CoreMessage.TYPE_BLOCK,
                    "Unknown block type '${block.type}'",
                    document,
                    JsonPointer.child(pointer, "type"),
                    id,
                    args =
                        mapOf(
                            "type" to JsonPrimitive(block.type),
                        ),
                )
            }
        }
        val used = model.blocks.keys.toMutableSet()
        model.connections.forEachIndexed { index, connection ->
            val pointer = JsonPointer.of("connections", index)
            if (connection.classes != null && connection.type != "route") {
                sink.error(
                    CoreMessage.CLASS_CONNECTION,
                    "Only route connections may define a classes filter",
                    document,
                    "$pointer/classes",
                    connection.id,
                )
            }
            if (!ID.matches(connection.id)) {
                val message = "Connection id '${connection.id}' must match ${ID.pattern}"
                sink.error(
                    CoreMessage.ID_CONNECTION,
                    message,
                    document,
                    "$pointer/id",
                    connection.id,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(connection.id),
                            "pattern" to JsonPrimitive(ID.pattern),
                        ),
                )
            }
            if (!used.add(connection.id)) {
                sink.error(
                    CoreMessage.ID_DUPLICATE,
                    "Id '${connection.id}' is already used",
                    document,
                    "$pointer/id",
                    connection.id,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(connection.id),
                        ),
                )
            }
            val type = catalog.type(connection.type)
            if (type == null || type.category != TypeCategory.CONNECTION) {
                sink.error(
                    CoreMessage.TYPE_CONNECTION,
                    "Unknown connection type '${connection.type}'",
                    document,
                    "$pointer/type",
                    connection.id,
                    args =
                        mapOf(
                            "type" to JsonPrimitive(connection.type),
                        ),
                )
                return@forEachIndexed
            }
            val from = model.blocks[connection.from]
            val to = model.blocks[connection.to]
            if (from == null) {
                sink.error(
                    CoreMessage.CONNECTION_SOURCE,
                    "Unknown source block '${connection.from}'",
                    document,
                    "$pointer/from",
                    connection.id,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(connection.from),
                        ),
                )
            }
            if (to == null) {
                sink.error(
                    CoreMessage.CONNECTION_TARGET,
                    "Unknown target block '${connection.to}'",
                    document,
                    "$pointer/to",
                    connection.id,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(connection.to),
                        ),
                )
            }
            val rule = type.connects
            if (from != null && to != null && rule != null && (from.type !in rule.fromTypes || to.type !in rule.toTypes)) {
                sink.error(
                    CoreMessage.CONNECTION_TYPE,
                    "Connection type '${type.id}' must connect ${rule.fromTypes.joinToString(
                        " or ",
                    )} to ${rule.toTypes.joinToString(" or ")}",
                    document,
                    "$pointer/type",
                    connection.id,
                    args =
                        mapOf(
                            "type" to JsonPrimitive(type.id),
                            "fromType" to JsonPrimitive(rule.fromTypes.joinToString(" or ")),
                            "toType" to JsonPrimitive(rule.toTypes.joinToString(" or ")),
                        ),
                )
            }
        }
        return sink.errorCount() == before
    }

    /** Applies overrides in key order, so an object comes before its fields whatever the document order; web does the same. */
    private fun applyOverrides(
        model: ModelFile,
        overrides: List<ParameterPatch>,
        variantId: String,
        document: String,
        sink: Diagnostics,
    ): Patched {
        var blocks = model.blocks
        val connections = model.connections.toMutableList()
        val pointers = mutableMapOf<String, MutableMap<String, String>>()
        overrides.forEach { patch ->
            val (path, value) = patch
            val segments = path.split('.')
            val target = segments.first()
            val paramPath = segments.drop(1)
            val block = blocks[target]
            val connectionIndex = connections.indexOfFirst { it.id == target }
            val typeId = block?.type ?: connections.getOrNull(connectionIndex)?.type
            val descriptors = typeId?.let { catalog.type(it)?.params }
            if (descriptors == null || paramPath.isEmpty() || !resolves(descriptors, paramPath)) {
                sink.error(
                    if (patch.pathPointer.startsWith("/grid/")) CoreMessage.GRID_PATH_PARAMETER else CoreMessage.OVERRIDE_PATH,
                    "Override '$path' does not name a parameter of a block or connection",
                    document,
                    patch.pathPointer,
                    target,
                    variantId,
                    args = mapOf("path" to JsonPrimitive(path)),
                )
                return@forEach
            }
            if (patch.pathPointer.startsWith("/grid/") && typeId == "client" && paramPath.first() in setOf("load", "classes")) {
                sink.error(
                    if (paramPath.first() == "classes") CoreMessage.GRID_CLASSES else CoreMessage.GRID_LOAD_PROFILE,
                    "Load profile '$path' does not support grid sweeps; compare profiles in variants",
                    document,
                    patch.pathPointer,
                    target,
                    variantId,
                    args = mapOf("path" to JsonPrimitive(path)),
                )
                return@forEach
            }
            if (block != null) {
                blocks = blocks + (target to block.copy(params = setIn(block.params, descriptors, paramPath, value)))
            } else {
                val connection = connections[connectionIndex]
                connections[connectionIndex] = connection.copy(params = setIn(connection.params, descriptors, paramPath, value))
            }
            val parameter = paramPath.joinToString(".")
            val origins = pointers.getOrPut(target) { mutableMapOf() }
            origins.keys.removeAll { it.startsWith("$parameter.") }
            origins[parameter] = patch.pointer
        }
        return Patched(
            model.copy(blocks = blocks, connections = connections),
            pointers.mapValues { OverrideOrigins(document, it.value, variantId) },
        )
    }

    private fun resolves(
        descriptors: List<ParamDescriptor>,
        path: List<String>,
    ): Boolean {
        val head = descriptors.firstOrNull { it.name == path.first() } ?: return false
        return path.size == 1 || (head.kind == ParamKind.OBJECT && resolves(head.fields, path.drop(1)))
    }

    private fun setIn(
        params: JsonObject,
        descriptors: List<ParamDescriptor>,
        path: List<String>,
        value: JsonElement,
    ): JsonObject {
        val name = path.first()
        if (path.size == 1) return JsonObject(params + (name to value))
        val descriptor = descriptors.first { it.name == name }
        val current = params[name] as? JsonObject ?: descriptor.default as? JsonObject ?: JsonObject(emptyMap())
        return JsonObject(params + (name to setIn(current, descriptor.fields, path.drop(1), value)))
    }

    private fun buildGraph(
        model: ModelFile,
        document: String,
        origins: Map<String, OverrideOrigins>,
        sink: Diagnostics,
        structureOk: Boolean,
        run: RunSettings?,
    ): GraphParts? {
        val before = sink.errorCount()
        val clients = model.blocks.filterValues { it.type == "client" }.toSortedMap()
        val services = model.blocks.filterValues { it.type in setOf("service", "database", "pooler") }.toSortedMap()
        val routers = model.blocks.filterValues { it.type == "router" }.toSortedMap()
        val clientNodes = clients.map { (id, block) -> readClient(id, block.params, document, origins[id], sink, run) }
        val classIds = clientNodes.filterNotNull().flatMap { it.classes.keys }.toSet()
        val outgoing = model.connections.filter { it.type == "call" }.groupBy { it.from }
        val serviceNodes =
            services.map { (id, block) ->
                if (block.type == "pooler") {
                    val outputs = outgoing[id].orEmpty()
                    if (outputs.size != 1) {
                        sink.error(
                            CoreMessage.POOLER_OUTPUT,
                            "Pooler '$id' must have exactly one outgoing call",
                            document,
                            JsonPointer.of("blocks", id),
                            id,
                            args = mapOf("pooler" to JsonPrimitive(id)),
                        )
                    }
                    outputs.filter { model.blocks[it.to]?.type == "pooler" }.forEach { output ->
                        sink.error(
                            CoreMessage.POOLER_TARGET,
                            "Pooler '$id' must call a database, service or router",
                            document,
                            JsonPointer.of("connections", model.connections.indexOf(output), "to"),
                            id,
                            args = mapOf("pooler" to JsonPrimitive(id)),
                        )
                    }
                    outputs.filter { "pool" in it.params }.forEach { output ->
                        val override = origins[output.id]
                        val descendants =
                            override
                                ?.pointers
                                ?.entries
                                .orEmpty()
                                .filter { it.key.startsWith("pool.") }
                        val nestedOrigin = (descendants.firstOrNull { it.value.startsWith("/grid/") } ?: descendants.firstOrNull())?.key
                        reader(
                            "call",
                            TypeCategory.CONNECTION,
                            output.params,
                            document,
                            JsonPointer.of("connections", model.connections.indexOf(output), "params"),
                            output.id,
                            sink,
                            override,
                        )?.fail<Unit>(
                            CoreMessage.POOLER_CALL_POOL,
                            "pool",
                            "Outgoing call of pooler '$id' must not declare a connection pool",
                            dependsOn = nestedOrigin,
                            args = mapOf("pooler" to JsonPrimitive(id)),
                        )
                    }
                    readPooler(id, block.params, document, origins[id], sink)
                } else {
                    val steps =
                        if (block.type ==
                            "service"
                        ) {
                            readScenario(id, block.scenario, outgoing[id].orEmpty().map { it.id }.toSet(), classIds, document, sink)
                        } else {
                            null
                        }
                    readService(id, block.params, document, origins[id], sink, block.type)?.copy(scenario = steps)
                }
            }
        val routerNodes = routers.map { (id, block) -> readRouter(id, block.params, document, origins[id], sink) }
        val indexed = model.connections.withIndex()
        val requests = indexed.filter { it.value.type == "request" }
        requests.forEach { (index, connection) ->
            // A request has no parameters; reading them against the catalog reports any that are written.
            reader(
                "request",
                TypeCategory.CONNECTION,
                connection.params,
                document,
                JsonPointer.of("connections", index, "params"),
                connection.id,
                sink,
            )
        }
        val calls = indexed.filter { it.value.type == "call" }.sortedBy { it.value.id }
        val callEdges = calls.map { (index, connection) -> readCall(index, connection, document, origins[connection.id], sink) }
        val routes = indexed.filter { it.value.type == "route" }.sortedBy { it.value.id }
        val routeEdges = routes.map { (index, connection) -> readRoute(index, connection, document, origins[connection.id], sink) }
        if (clients.isEmpty()) {
            sink.error(
                CoreMessage.TOPOLOGY_CLIENT,
                "The model must contain at least one client block; found ${clients.size}",
                document,
                "/blocks",
                args =
                    mapOf(
                        "found" to JsonPrimitive(clients.size),
                    ),
            )
        }
        clients.keys.forEach { id ->
            val found = requests.count { it.value.from == id }
            if (found != 1) {
                sink.error(
                    CoreMessage.CLIENT_REQUEST,
                    "Client '$id' must have exactly one request connection; found $found",
                    document,
                    JsonPointer.of("blocks", id),
                    id,
                    args = mapOf("client" to JsonPrimitive(id), "found" to JsonPrimitive(found)),
                )
            }
        }
        val entries = requests.map { it.value.to }.filter { it in services }.toSet()
        checkGraph(
            entries,
            (services + routers).mapValues { it.value.type },
            routers.keys,
            calls + routes,
            document,
            sink,
        )
        val inputs =
            clientNodes.filterNotNull().map { client ->
                client.copy(
                    entry =
                        requests
                            .singleOrNull { it.value.from == client.path }
                            ?.value
                            ?.to
                            .orEmpty(),
                )
            }
        routes.forEach { (index, route) ->
            checkClassFilter(route.classes, classIds, document, JsonPointer.of("connections", index, "classes"), route.id, sink)
        }
        if (!structureOk || sink.errorCount() > before) return null
        checkRouterClasses(inputs, serviceNodes.filterNotNull(), callEdges.filterNotNull(), routeEdges.filterNotNull(), document, sink)
        if (sink.errorCount() > before) return null
        return GraphParts(
            inputs,
            serviceNodes.map {
                it!!
            },
            callEdges.map { it!! },
            routerNodes.map { it!! },
            routeEdges.map { it!! },
        )
    }

    private fun checkGraph(
        entries: Set<String>,
        types: Map<String, String>,
        routers: Set<String>,
        calls: List<IndexedValue<ConnectionInstance>>,
        document: String,
        sink: Diagnostics,
    ) {
        val services = types.keys
        val validOutgoing = calls.filter { it.value.from in services && it.value.to in services }.groupBy { it.value.from }
        routers.sorted().forEach { router ->
            if (validOutgoing[router].orEmpty().none { it.value.type == "route" }) {
                sink.error(
                    CoreMessage.ROUTER_OUTPUT,
                    "Router '$router' must have at least one route output",
                    document,
                    JsonPointer.of("blocks", router),
                    router,
                    args = mapOf("router" to JsonPrimitive(router)),
                )
            }
            if (calls.count { it.value.to == router } != 1) {
                sink.error(
                    CoreMessage.ROUTER_INPUT,
                    "Router '$router' must have exactly one incoming call or route",
                    document,
                    JsonPointer.of("blocks", router),
                    router,
                    args = mapOf("router" to JsonPrimitive(router)),
                )
            }
        }
        calls.filter { it.value.to in entries }.forEach { (index, call) ->
            val entry = call.to
            sink.error(
                CoreMessage.GRAPH_ENTRY,
                "Entry service '$entry' must not receive calls",
                document,
                JsonPointer.of("connections", index, "to"),
                call.id,
                args = mapOf("service" to JsonPrimitive(entry)),
            )
        }
        val visited = mutableSetOf<String>()
        val active = mutableSetOf<String>()
        services.sorted().forEach { start ->
            if (!visited.add(start)) return@forEach
            active.add(start)
            val pending = ArrayDeque<Pair<String, Iterator<IndexedValue<ConnectionInstance>>>>()
            pending.addLast(start to validOutgoing[start].orEmpty().iterator())
            while (pending.isNotEmpty()) {
                val (current, edges) = pending.last()
                if (!edges.hasNext()) {
                    active.remove(current)
                    pending.removeLast()
                    continue
                }
                val (index, edge) = edges.next()
                val next = edge.to
                if (next in active) {
                    val members = pending.map { it.first }.dropWhile { it != next }
                    val cycleEdges =
                        members.zipWithNext().map { (from, to) ->
                            validOutgoing
                                .getValue(from)
                                .first { it.value.to == to }
                                .value.id
                        } + edge.id
                    val cycle = (members + next).joinToString(" -> ")
                    val connections = cycleEdges.joinToString(", ")
                    sink.error(
                        CoreMessage.GRAPH_CYCLE,
                        "Calls form a cycle: $cycle (connections: $connections)",
                        document,
                        JsonPointer.of("connections", index),
                        edge.id,
                        args = mapOf("cycle" to JsonPrimitive(cycle), "connections" to JsonPrimitive(connections)),
                    )
                } else if (visited.add(next)) {
                    active.add(next)
                    pending.addLast(next to validOutgoing[next].orEmpty().iterator())
                }
            }
        }
        if (entries.isEmpty()) return
        val reachable = mutableSetOf<String>()
        val pending = ArrayDeque<String>()
        entries.sorted().forEach(pending::addLast)
        while (pending.isNotEmpty()) {
            val current = pending.removeFirst()
            if (reachable.add(current)) validOutgoing[current].orEmpty().forEach { pending.addLast(it.value.to) }
        }
        (services - reachable).sorted().forEach {
            val type = types.getValue(it)
            sink.error(
                CoreMessage.GRAPH_UNREACHABLE,
                "${type.replaceFirstChar(Char::uppercaseChar)} '$it' is not reachable from any client",
                document,
                JsonPointer.of("blocks", it),
                it,
                args =
                    mapOf(
                        "elementType" to JsonPrimitive(type),
                        "service" to JsonPrimitive(it),
                    ),
            )
        }
    }

    private fun readScenario(
        id: String,
        steps: List<ScenarioStep>?,
        outgoing: Set<String>,
        classIds: Set<String>,
        document: String,
        sink: Diagnostics,
    ): List<ServiceStep>? {
        val pointer = JsonPointer.of("blocks", id)
        if (steps == null) {
            if (outgoing.size > 1) {
                sink.error(
                    CoreMessage.SCENARIO_REQUIRED,
                    "Service '$id' needs a scenario for multiple outgoing calls",
                    document,
                    pointer,
                    id,
                    args = mapOf("service" to JsonPrimitive(id)),
                )
            }
            return null
        }
        if (steps.isEmpty()) {
            sink.error(
                CoreMessage.SCENARIO_EMPTY,
                "A service scenario must not be empty",
                document,
                "$pointer/scenario",
                id,
            )
        }
        return steps.mapIndexedNotNull { index, step ->
            val location = "$pointer/scenario/$index"
            val classes = checkClassFilter(step.classes, classIds, document, "$location/classes", id, sink)
            val invalidFields =
                when (step.type) {
                    "process" -> listOfNotNull(step.connection?.let { "connection" })
                    "call" -> listOfNotNull(step.processing?.let { "processing" }, step.failureRate?.let { "failureRate" })
                    else -> emptyList()
                }
            invalidFields.forEach { field ->
                sink.error(
                    CoreMessage.SCENARIO_FIELD,
                    "Field '$field' does not apply to scenario step '${step.type}'",
                    document,
                    "$location/$field",
                    id,
                    args = mapOf("field" to JsonPrimitive(field), "type" to JsonPrimitive(step.type)),
                )
            }
            when (step.type) {
                "process" -> {
                    val params =
                        JsonObject(
                            buildMap {
                                step.processing?.let { put("processing", it) }
                                step.failureRate?.let { put("failureRate", JsonPrimitive(it)) }
                            },
                        )
                    val descriptors =
                        catalog
                            .type("service")
                            ?.params
                            .orEmpty()
                            .filter { it.name in setOf("processing", "failureRate") }
                    if (descriptors.isEmpty()) return@mapIndexedNotNull null
                    val reader = ParamReader(params, descriptors, document, location, id, sink.items)
                    ServiceStep.Process(
                        step.processing?.let { reader.obj("processing")?.let(::distribution) },
                        step.failureRate?.let { reader.quantity("failureRate") },
                        classes,
                    )
                }
                "call" -> {
                    val connection = step.connection
                    if (connection !in outgoing) {
                        sink.error(
                            CoreMessage.SCENARIO_CONNECTION,
                            "Scenario of service '$id' must call an outgoing connection; found '${connection.orEmpty()}'",
                            document,
                            "$location/connection",
                            id,
                            args = mapOf("service" to JsonPrimitive(id), "connection" to JsonPrimitive(connection.orEmpty())),
                        )
                        null
                    } else {
                        ServiceStep.Call(requireNotNull(connection), classes)
                    }
                }
                else -> {
                    sink.error(
                        CoreMessage.SCENARIO_STEP_TYPE,
                        "Unknown scenario step type '${step.type}'; expected process or call",
                        document,
                        "$location/type",
                        id,
                        args = mapOf("type" to JsonPrimitive(step.type)),
                    )
                    null
                }
            }
        }
    }

    private fun readClient(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
        run: RunSettings?,
    ): ClientNode? {
        val reader =
            reader("client", TypeCategory.BLOCK, params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
                ?: return null
        val hasLoad = reader.has("load")
        val hasClasses = reader.has("classes")
        if (hasLoad == hasClasses) {
            return reader.fail(
                CoreMessage.CLIENT_LOAD,
                if (hasClasses) "classes" else "load",
                "Client '$id' must declare either load or classes",
                dependsOn = if (hasClasses) "load" else "classes",
                args = mapOf("client" to JsonPrimitive(id)),
            )
        }
        val deadline = reader.quantity("deadline")
        val profiles = linkedMapOf<String, LoadProfile>()
        if (hasClasses) {
            reader.objects("classes")?.forEach { item ->
                val classId = item.string("id")
                if (classId != null) {
                    when {
                        !ID.matches(classId) ->
                            item.fail<Unit>(
                                CoreMessage.CLASS_ID,
                                "id",
                                "Class id '$classId' must match ${ID.pattern}",
                                args =
                                    mapOf(
                                        "id" to JsonPrimitive(classId),
                                        "pattern" to JsonPrimitive(ID.pattern),
                                    ),
                            )
                        classId == "default" ->
                            item.fail<Unit>(
                                CoreMessage.CLASS_RESERVED,
                                "id",
                                "Class id 'default' is reserved for clients without explicit classes",
                            )
                        classId in profiles ->
                            item.fail<Unit>(
                                CoreMessage.CLASS_DUPLICATE,
                                "id",
                                "Class id '$classId' is repeated in client '$id'",
                                args =
                                    mapOf(
                                        "id" to JsonPrimitive(classId),
                                        "client" to JsonPrimitive(id),
                                    ),
                            )
                    }
                }
                val load = readLoad(item, run)
                if (classId != null && load != null) profiles[classId] = load
            }
        } else {
            readLoad(reader, run)?.let { profiles["default"] = it }
        }
        if (profiles.isEmpty() || deadline == null) return null
        return ClientNode(id.split('/'), profiles.toSortedMap(), deadline, "", Origin(document, JsonPointer.of("blocks", id)))
    }

    private fun readLoad(
        reader: ParamReader,
        run: RunSettings?,
    ): LoadProfile? {
        val pointReaders = reader.obj("load")?.objects("points") ?: return null
        val points =
            pointReaders.map { point ->
                val time = point.quantity("time")
                val rate = point.quantity("rate")
                if (time == null || rate == null) null else LoadPoint(time, rate)
            }
        pointReaders.forEachIndexed { index, point ->
            if (index > 0 && points[index] != null && points[index - 1] != null && points[index]!!.timeMs <= points[index - 1]!!.timeMs) {
                point.fail<Unit>(CoreMessage.LOAD_POINT_ORDER, "time", "Load point times must be strictly increasing")
            }
        }
        if (points.any { it == null }) return null
        if (points.filterNotNull().zipWithNext().any { (a, b) -> a.timeMs >= b.timeMs }) return null
        val load = LoadProfile(points.filterNotNull())
        if (run != null) {
            val maximum = load.maximum(run.warmupMs + run.measurementMs)
            if (!maximum.isFinite() || (maximum > 0.0 && !(1.0 / maximum).isFinite())) {
                return reader.fail(
                    CoreMessage.LOAD_RANGE,
                    "load",
                    "Load intensity and its positive mean inter-arrival interval must be finite",
                    dependsOn = "load.points",
                )
            }
        }
        return load
    }

    private fun checkClassFilter(
        classes: List<String>?,
        declared: Set<String>,
        document: String,
        pointer: String,
        path: String,
        sink: Diagnostics,
    ): Set<String>? {
        if (classes == null) return null
        if (classes.isEmpty() || classes.distinct().size != classes.size) {
            sink.error(
                CoreMessage.CLASS_FILTER,
                "Class filters must be non-empty lists of unique class identifiers",
                document,
                pointer,
                path,
            )
        }
        classes.forEachIndexed { index, id ->
            if (id !in declared) {
                sink.error(
                    CoreMessage.CLASS_UNKNOWN,
                    "Request class '$id' is not declared by any client",
                    document,
                    "$pointer/$index",
                    path,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(id),
                        ),
                )
            }
        }
        return classes.toSet()
    }

    private fun checkRouterClasses(
        clients: List<ClientNode>,
        services: List<ServiceNode>,
        calls: List<CallEdge>,
        routes: List<RouteEdge>,
        document: String,
        sink: Diagnostics,
    ) {
        val servicesByPath = services.associateBy { it.path }
        val outgoingCalls = calls.groupBy { it.from }
        val callsByPath = calls.associateBy { it.path }
        val outputs = routes.groupBy { it.from }
        val visited = mutableSetOf<Pair<String, String>>()
        val pending = ArrayDeque<Pair<String, String>>()
        clients.forEach { client -> client.classes.keys.forEach { pending.addLast(client.entry to it) } }
        while (pending.isNotEmpty()) {
            val (path, requestClass) = pending.removeFirst()
            if (!visited.add(path to requestClass)) continue
            val service = servicesByPath[path]
            if (service != null) {
                val steps = service.scenario ?: outgoingCalls[path].orEmpty().map { ServiceStep.Call(it.path) }
                steps.filterIsInstance<ServiceStep.Call>().filter { it.classes == null || requestClass in it.classes }.forEach { step ->
                    pending.addLast(callsByPath.getValue(step.edge).to to requestClass)
                }
            } else {
                val available = outputs[path].orEmpty().filter { it.classes == null || requestClass in it.classes }
                if (available.isEmpty()) {
                    sink.error(
                        CoreMessage.ROUTER_CLASS,
                        "Router '$path' has no route for request class '$requestClass'",
                        document,
                        JsonPointer.of("blocks", path),
                        path,
                        args =
                            mapOf(
                                "router" to JsonPrimitive(path),
                                "id" to JsonPrimitive(requestClass),
                            ),
                    )
                }
                available.forEach { pending.addLast(it.to to requestClass) }
            }
        }
    }

    private fun routingPolicy(value: String): RoutingPolicy =
        when (value) {
            "roundRobin" -> RoutingPolicy.ROUND_ROBIN
            "random" -> RoutingPolicy.RANDOM
            else -> RoutingPolicy.LEAST_IN_FLIGHT
        }

    private fun expandReplicas(
        graph: GraphIr,
        model: ModelFile,
        document: String,
        origins: Map<String, OverrideOrigins>,
        sink: Diagnostics,
    ): GraphIr {
        val before = sink.errorCount()
        val instances =
            graph.services.associate { service ->
                val id = service.path
                val block = model.blocks.getValue(id)
                if (block.type != "service") return@associate id to listOf(service)
                val pointer = JsonPointer.of("blocks", id)
                val reader = reader("service", TypeCategory.BLOCK, block.params, document, "$pointer/params", id, sink, origins[id])!!
                val count = reader.int("replicas") ?: 1
                val overrides = mutableMapOf<Int, JsonObject>()
                block.replicaOverrides.orEmpty().toSortedMap().forEach { (number, params) ->
                    val replica = number.toIntOrNull()
                    if (replica == null || replica !in 1..count || replica.toString() != number) {
                        sink.error(
                            CoreMessage.REPLICA_INDEX,
                            "Replica '$number' of service '$id' must be an integer from 1 to $count",
                            document,
                            JsonPointer.of("blocks", id, "replicaOverrides", number),
                            id,
                            origins[id]?.variant,
                            args =
                                mapOf(
                                    "replica" to JsonPrimitive(number),
                                    "service" to JsonPrimitive(id),
                                    "replicas" to JsonPrimitive(count),
                                ),
                        )
                    } else {
                        overrides[replica] = params
                    }
                }
                id to
                    (1..count).map { number ->
                        val params = overrides[number] ?: return@map service
                        val start = sink.items.size
                        if ("replicas" in params) {
                            sink.error(
                                CoreMessage.REPLICA_PARAMETER,
                                "replicaOverrides cannot change the group parameter 'replicas'",
                                document,
                                "$pointer/params/replicas",
                                id,
                                args = mapOf("parameter" to JsonPrimitive("replicas")),
                            )
                        }
                        val instance = readService(id, mergeParameters(block.params, params), document, null, sink)
                        for (index in start until sink.items.size) {
                            val diagnostic = sink.items[index]
                            sink.items[index] =
                                diagnostic.copy(
                                    pointer = diagnostic.pointer?.replace("$pointer/params", "$pointer/replicaOverrides/$number"),
                                    path = "$id#$number",
                                    message = "Replica '$id#$number': ${diagnostic.message}",
                                    args =
                                        diagnostic.args.orEmpty() +
                                            mapOf("replica" to JsonPrimitive(number), "service" to JsonPrimitive(id)),
                                )
                        }
                        (instance ?: service).copy(scenario = service.scenario)
                    }
            }
        graph.calls.forEach { call ->
            if (call.outlierDetection != null && instances[call.to].orEmpty().size < 2) {
                val index = model.connections.indexOfFirst { it.id == call.path }
                reader(
                    "call",
                    TypeCategory.CONNECTION,
                    model.connections[index].params,
                    document,
                    JsonPointer.of("connections", index, "params"),
                    call.path,
                    sink,
                    origins[call.path],
                )?.fail<Unit>(
                    CoreMessage.OUTLIER_TARGET,
                    "outlierDetection",
                    "Outlier detection on connection '${call.path}' requires a replica-group target",
                    args = mapOf("connection" to JsonPrimitive(call.path)),
                )
            }
        }
        graph.calls.groupBy { it.to }.forEach { (target, calls) ->
            if (instances[target].orEmpty().size > 1 && calls.map { it.outlierDetection }.distinct().size > 1) {
                calls.forEach { call ->
                    val index = model.connections.indexOfFirst { it.id == call.path }
                    val override = origins[call.path]
                    val source =
                        override
                            ?.pointers
                            ?.entries
                            ?.firstOrNull { it.key.startsWith("outlierDetection") }
                            ?.value
                    sink.error(
                        CoreMessage.OUTLIER_CONFIG,
                        "All calls to replica group '$target' must use identical outlier detection parameters",
                        if (source == null) document else override.document,
                        source ?: JsonPointer.of("connections", index, "params", "outlierDetection"),
                        call.path,
                        override?.variant,
                        args = mapOf("group" to JsonPrimitive(target)),
                    )
                }
            }
        }
        return if (sink.errorCount() > before) graph else graph.expandReplicaGroups(instances)
    }

    private fun mergeParameters(
        base: JsonObject,
        patch: JsonObject,
    ): JsonObject =
        JsonObject(
            base +
                patch.mapValues { (name, value) ->
                    val previous = base[name]
                    if (previous is JsonObject && value is JsonObject) mergeParameters(previous, value) else value
                },
        )

    private fun readPooler(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): ServiceNode? {
        val reader =
            reader("pooler", TypeCategory.BLOCK, params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
                ?: return null
        val clients = reader.int("maxClientConnections")
        val size = reader.int("poolSize")
        val wait = reader.quantity("waitTimeout")
        val processing = reader.obj("processing")?.let(::distribution)
        if (clients == null || size == null || wait == null || processing == null) return null
        return ServiceNode(
            id,
            clients,
            0,
            processing,
            0.0,
            Origin(document, JsonPointer.of("blocks", id)),
            pooler = PoolerSettings(size, wait),
        )
    }

    private fun readService(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
        type: String = "service",
    ): ServiceNode? {
        val reader =
            reader(type, TypeCategory.BLOCK, params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
                ?: return null
        val handlers = reader.int(if (type == "database") "maxConnections" else "handlers")
        val queue = reader.int("queue")
        val processing = reader.obj("processing")?.let(::distribution)
        val failure = reader.quantity("failureRate")
        val rateLimit = if (type == "service" && reader.has("rateLimit")) reader.obj("rateLimit")?.let(::rateLimit) else null
        val healthCheck = if (type == "service" && reader.has("healthCheck")) reader.obj("healthCheck")?.let(::healthCheck) else null
        return if (handlers == null || queue == null || processing == null || failure == null) {
            null
        } else {
            ServiceNode(
                id,
                handlers,
                queue,
                processing,
                failure,
                Origin(document, JsonPointer.of("blocks", id)),
                type = type,
                rateLimit = rateLimit,
                healthCheck = healthCheck,
            )
        }
    }

    private fun rateLimit(reader: ParamReader): RateLimitConfig? {
        val rate = reader.quantity("rate")
        val burst = reader.int("burst")
        return if (rate == null || burst == null) null else RateLimitConfig(rate, burst)
    }

    private fun healthCheck(reader: ParamReader): HealthCheckConfig? {
        val interval = reader.quantity("interval")
        val timeout = reader.quantity("timeout")
        val unhealthy = reader.int("unhealthyThreshold")
        val healthy = reader.int("healthyThreshold")
        val processing = reader.quantity("processing")
        return if (interval == null || timeout == null || unhealthy == null || healthy == null || processing == null) {
            null
        } else {
            HealthCheckConfig(interval, timeout, unhealthy, healthy, processing)
        }
    }

    private fun readCall(
        index: Int,
        connection: ConnectionInstance,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): CallEdge? {
        val pointer = JsonPointer.of("connections", index, "params")
        val reader =
            reader("call", TypeCategory.CONNECTION, connection.params, document, pointer, connection.id, sink, overrides) ?: return null
        val network = reader.obj("network")?.let(::distribution)
        val timeout = reader.quantity("timeout")
        val attempts = reader.int("attempts")
        val backoff = reader.obj("backoff")?.let(::backoff)
        val pool =
            if (reader.has("pool")) {
                reader.obj("pool")?.let { fields ->
                    val size = fields.int("size")
                    val acquireTimeout = fields.quantity("acquireTimeout")
                    if (size == null || acquireTimeout == null) null else CallPool(size, acquireTimeout)
                }
            } else {
                null
            }
        val retryTarget = reader.choice("retryTarget")
        val balancing = if (reader.has("balancing")) reader.choice("balancing")?.let(::routingPolicy) else null
        val circuitBreaker = if (reader.has("circuitBreaker")) reader.obj("circuitBreaker")?.let(::circuitBreaker) else null
        val retryBudget = if (reader.has("retryBudget")) reader.obj("retryBudget")?.let(::retryBudget) else null
        val fallback = if (reader.has("fallback")) reader.obj("fallback")?.let(::fallback) else null
        val outlierDetection = if (reader.has("outlierDetection")) reader.obj("outlierDetection")?.let(::outlierDetection) else null
        return if (network == null || timeout == null || attempts == null || backoff == null || retryTarget == null) {
            null
        } else {
            val origin = Origin(document, JsonPointer.of("connections", index))
            CallEdge(
                connection.id,
                connection.from,
                connection.to,
                network,
                timeout,
                attempts,
                backoff,
                origin,
                if (retryTarget == "other") RetryTarget.OTHER else RetryTarget.ANY,
                balancing,
                pool,
                circuitBreaker,
                retryBudget,
                fallback,
                outlierDetection,
            )
        }
    }

    private fun circuitBreaker(reader: ParamReader): CircuitBreakerConfig? {
        val failureRate = reader.quantity("failureRate")
        val minimumCalls = reader.int("minimumCalls")
        val window = reader.int("window")
        val openDuration = reader.quantity("openDuration")
        val halfOpenCalls = reader.int("halfOpenCalls")
        if (minimumCalls != null && window != null && minimumCalls > window) {
            return reader.fail(CoreMessage.CIRCUIT_WINDOW, "minimumCalls", "minimumCalls must not exceed window", dependsOn = "window")
        }
        return if (failureRate == null || minimumCalls == null || window == null || openDuration == null || halfOpenCalls == null) {
            null
        } else {
            CircuitBreakerConfig(failureRate, minimumCalls, window, openDuration, halfOpenCalls)
        }
    }

    private fun retryBudget(reader: ParamReader): RetryBudgetConfig? {
        val ratio = reader.quantity("ratio")
        val minimum = reader.quantity("minPerSecond")
        val window = reader.quantity("window")
        return if (ratio == null || minimum == null || window == null) null else RetryBudgetConfig(ratio, minimum, window)
    }

    private fun fallback(reader: ParamReader): FallbackConfig? {
        val on = reader.choices("on")
        val processing = reader.quantity("processing")
        return if (on == null || processing == null) null else FallbackConfig(on, processing)
    }

    private fun readRouter(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): RouterNode? {
        val reader =
            reader("router", TypeCategory.BLOCK, params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
                ?: return null
        val policy = routingPolicy(reader.choice("policy") ?: return null)
        val outlierDetection = if (reader.has("outlierDetection")) reader.obj("outlierDetection")?.let(::outlierDetection) else null
        return RouterNode(id, policy, Origin(document, JsonPointer.of("blocks", id)), outlierDetection)
    }

    private fun outlierDetection(reader: ParamReader): OutlierDetectionConfig? {
        val failures = reader.int("consecutiveFailures")
        val duration = reader.quantity("baseEjection")
        val fraction = reader.quantity("maxEjected")
        return if (failures == null || duration == null || fraction == null) null else OutlierDetectionConfig(failures, duration, fraction)
    }

    private fun readRoute(
        index: Int,
        connection: ConnectionInstance,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): RouteEdge? {
        val reader =
            reader(
                "route",
                TypeCategory.CONNECTION,
                connection.params,
                document,
                JsonPointer.of("connections", index, "params"),
                connection.id,
                sink,
                overrides,
            ) ?: return null
        val weight = reader.number("weight") ?: return null
        return RouteEdge(
            connection.id,
            connection.from,
            connection.to,
            weight,
            Origin(document, JsonPointer.of("connections", index)),
            connection.classes?.toSet(),
        )
    }

    private fun distribution(reader: ParamReader): Distribution? {
        val kind = reader.choice("kind")
        val mean = reader.quantity("mean")
        val stdDev = reader.quantity("stdDev")
        if (kind == "lognormal" && !reader.has("stdDev")) {
            reader.fail<Unit>(CoreMessage.PARAM_LOGNORMAL, "stdDev", "lognormal requires stdDev", dependsOn = "kind")
        }
        if (kind == null || mean == null) return null
        if (kind != "lognormal" && reader.has("stdDev")) {
            return reader.fail(CoreMessage.DISTRIBUTION_RULE, "stdDev", "stdDev applies only to lognormal", dependsOn = "kind")
        }
        if (kind != "fixed" && mean <= 0.0) {
            return reader.fail(
                CoreMessage.PARAM_POSITIVE_MEAN,
                "mean",
                "mean must be greater than zero for $kind",
                dependsOn = "kind",
                args =
                    mapOf(
                        "kind" to JsonPrimitive(kind),
                    ),
            )
        }
        return when (kind) {
            "fixed" -> Distribution(DistributionShape.FIXED, mean)
            "exponential" -> Distribution(DistributionShape.EXPONENTIAL, mean)
            else ->
                if (stdDev == null) {
                    null
                } else {
                    Distribution(DistributionShape.LOGNORMAL, mean, stdDev)
                }
        }
    }

    private fun backoff(reader: ParamReader): Backoff? {
        val kind = reader.choice("kind")
        val base = reader.quantity("base")
        val max = reader.quantity("max")
        val multiplier = reader.number("multiplier")
        if (kind == null || base == null || max == null || multiplier == null) return null
        val backoffKind =
            when (kind) {
                "none" -> BackoffKind.NONE
                "fixed" -> BackoffKind.FIXED
                else -> BackoffKind.EXPONENTIAL_FULL_JITTER
            }
        return Backoff(backoffKind, base, max, multiplier)
    }

    private fun reader(
        type: String,
        category: TypeCategory,
        params: JsonObject,
        document: String,
        pointer: String,
        path: String,
        sink: Diagnostics,
        overrides: OverrideOrigins? = null,
    ): ParamReader? =
        catalog.type(type)?.takeIf { it.category == category }?.let {
            ParamReader(params, it.params, document, pointer, path, sink.items, overrides ?: OverrideOrigins.NONE)
        }

    private fun runSettings(
        experiment: ExperimentFile,
        document: String,
        sink: Diagnostics,
    ): RunSettings? {
        val execution = experiment.execution
        val before = sink.errorCount()
        if (execution.replications < 1) {
            sink.error(
                CoreMessage.EXECUTION_REPLICATIONS,
                "replications must be at least 1",
                document,
                "/execution/replications",
                args =
                    mapOf(
                        "minimum" to JsonPrimitive(1),
                    ),
            )
        }
        val warmup = duration(execution.warmup, "/execution/warmup", document, sink, allowZero = true)
        val measurement = duration(execution.measurement, "/execution/measurement", document, sink, allowZero = false)
        val maxRealTime = duration(execution.maxRealTime, "/execution/maxRealTime", document, sink, allowZero = false)
        val window =
            execution.window?.let { duration(it, "/execution/window", document, sink, allowZero = false) }
                ?: measurement?.div(100.0)
        if (execution.seed !in 0L..MAX_SEED) {
            sink.error(
                CoreMessage.SEED_RANGE,
                "seed must be an integer from 0 to $MAX_SEED",
                document,
                "/execution/seed",
                args =
                    mapOf(
                        "minimum" to JsonPrimitive(0),
                        "maximum" to JsonPrimitive(MAX_SEED),
                    ),
            )
        }
        if (warmup != null && measurement != null && !(warmup + measurement).isFinite()) {
            sink.error(CoreMessage.EXECUTION_TOTAL_DURATION, "warmup plus measurement must be finite", document, "/execution/measurement")
        }
        if (warmup != null &&
            measurement != null &&
            (warmup + measurement).isFinite() &&
            window != null
        ) {
            try {
                windowCount(warmup + measurement, window)
            } catch (failure: WindowCountException) {
                sink.error(
                    if (failure.reason ==
                        WindowGridFailure.DURATION
                    ) {
                        CoreMessage.EXECUTION_WINDOW_DURATION
                    } else {
                        CoreMessage.EXECUTION_WINDOW_COUNT
                    },
                    requireNotNull(failure.message),
                    document,
                    "/execution/window",
                    args =
                        mapOf(
                            "maximum" to JsonPrimitive(Int.MAX_VALUE),
                        ),
                )
            }
        }
        if (sink.errorCount() > before || warmup == null || measurement == null || maxRealTime == null) return null
        return RunSettings(
            execution.replications,
            warmup,
            measurement,
            execution.seed,
            ceil(maxRealTime / 1_000.0).toLong().coerceAtLeast(1L),
            requireNotNull(window),
        )
    }

    private fun faults(
        experiment: ExperimentFile,
        model: ModelFile,
        document: String,
        sink: Diagnostics,
        run: RunSettings?,
    ): List<FaultSpan> =
        experiment.faults.mapIndexedNotNull { index, fault ->
            val pointer = JsonPointer.of("faults", index)
            val before = sink.errorCount()
            val base = fault.target.substringBefore('#')
            if (model.blocks[base]?.type !in setOf("service", "database", "pooler") &&
                model.connections.none { it.id == base && it.type in setOf("call", "route") }
            ) {
                sink.error(
                    CoreMessage.FAULT_TARGET,
                    "Fault target '${fault.target}' is not a service, database, pooler, replica, call or route",
                    document,
                    "$pointer/target",
                    fault.target,
                    args = mapOf("target" to JsonPrimitive(fault.target)),
                )
            }
            val kind =
                when (fault.kind) {
                    "slowdown" -> FaultKind.SLOWDOWN
                    "errors" -> FaultKind.ERRORS
                    "unavailable" -> FaultKind.UNAVAILABLE
                    "blackhole" -> FaultKind.BLACKHOLE
                    "capacityLoss" -> FaultKind.CAPACITY_LOSS
                    else -> {
                        sink.error(
                            CoreMessage.FAULT_KIND,
                            "Unknown fault kind '${fault.kind}'",
                            document,
                            "$pointer/kind",
                            fault.target,
                            args = mapOf("kind" to JsonPrimitive(fault.kind)),
                        )
                        null
                    }
                }
            val from = duration(fault.from, "$pointer/from", document, sink, allowZero = true)
            val to = duration(fault.to, "$pointer/to", document, sink, allowZero = true)
            if (from != null && to != null) {
                if (to <= from) {
                    sink.error(CoreMessage.FAULT_INTERVAL, "Fault must end after it starts", document, "$pointer/to", fault.target)
                } else if (run != null && to > run.warmupMs + run.measurementMs) {
                    val durationMs = run.warmupMs + run.measurementMs
                    sink.error(
                        CoreMessage.FAULT_INTERVAL_OUTSIDE,
                        "Fault interval must be within the run from 0 to $durationMs ms",
                        document,
                        "$pointer/to",
                        fault.target,
                        args = mapOf("durationMs" to JsonPrimitive(durationMs)),
                    )
                }
            }
            val allowed =
                when (kind) {
                    FaultKind.SLOWDOWN -> setOf("multiplier", "delay")
                    FaultKind.ERRORS -> setOf("failureRate")
                    FaultKind.CAPACITY_LOSS -> setOf("capacity")
                    else -> emptySet()
                }
            val fields =
                listOfNotNull(
                    fault.multiplier?.let { "multiplier" },
                    fault.delay?.let { "delay" },
                    fault.failureRate?.let { "failureRate" },
                    fault.capacity?.let { "capacity" },
                )
            if (kind != null) {
                (fields - allowed).forEach { field ->
                    sink.error(
                        CoreMessage.FAULT_FIELD,
                        "Field '$field' does not apply to fault kind '${fault.kind}'",
                        document,
                        "$pointer/$field",
                        fault.target,
                        args = mapOf("field" to JsonPrimitive(field), "kind" to JsonPrimitive(fault.kind)),
                    )
                }
            }
            val multiplier = if (kind == FaultKind.SLOWDOWN) fault.multiplier else null
            if (multiplier != null && !(multiplier > 0.0 && multiplier.isFinite())) {
                sink.error(
                    CoreMessage.PARAM_EXCLUSIVE_MINIMUM,
                    "Parameter 'multiplier' is out of range: > 0",
                    document,
                    "$pointer/multiplier",
                    fault.target,
                    args = mapOf("parameter" to JsonPrimitive("multiplier"), "minimum" to JsonPrimitive(0)),
                )
            }
            val delay =
                if (kind == FaultKind.SLOWDOWN) {
                    fault.delay?.let { duration(it, "$pointer/delay", document, sink, allowZero = true) }
                } else {
                    null
                }
            if (kind == FaultKind.SLOWDOWN && multiplier == null && fault.delay == null) {
                sink.error(
                    CoreMessage.FAULT_EMPTY,
                    "Slowdown fault must set multiplier or delay",
                    document,
                    pointer,
                    fault.target,
                )
            }
            val required =
                when (kind) {
                    FaultKind.ERRORS -> "failureRate"
                    FaultKind.CAPACITY_LOSS -> "capacity"
                    else -> null
                }
            if (required != null && required !in fields) {
                sink.error(
                    CoreMessage.PARAM_MISSING,
                    "Required parameter '$required' is missing",
                    document,
                    "$pointer/$required",
                    fault.target,
                    args = mapOf("parameter" to JsonPrimitive(required)),
                )
            }
            val failure =
                if (kind == FaultKind.ERRORS) {
                    fault.failureRate?.let { text ->
                        Quantities.parse(text, Dimension.PROBABILITY)?.takeIf { it <= 1.0 }.also {
                            if (it == null) {
                                sink.error(
                                    CoreMessage.QUANTITY_FAILURE_RATE,
                                    "failureRate must be a percentage from 0% to 100%",
                                    document,
                                    "$pointer/failureRate",
                                    fault.target,
                                    args = mapOf("minimum" to JsonPrimitive(0), "maximum" to JsonPrimitive(100)),
                                )
                            }
                        }
                    }
                } else {
                    null
                }
            if (kind == FaultKind.CAPACITY_LOSS && fault.capacity != null && fault.capacity < 0) {
                sink.error(
                    CoreMessage.PARAM_MINIMUM,
                    "Parameter 'capacity' is out of range: >= 0",
                    document,
                    "$pointer/capacity",
                    fault.target,
                    args = mapOf("parameter" to JsonPrimitive("capacity"), "minimum" to JsonPrimitive(0)),
                )
            }
            if (sink.errorCount() > before) {
                null
            } else {
                FaultSpan(
                    fault.target,
                    requireNotNull(from),
                    requireNotNull(to),
                    requireNotNull(kind),
                    multiplier ?: 1.0,
                    delay ?: 0.0,
                    failure,
                    fault.capacity,
                    Origin(document, pointer),
                )
            }
        }

    private fun bindFaults(
        faults: List<FaultSpan>,
        graph: GraphIr,
        sink: Diagnostics,
        variant: String,
    ): List<FaultSpan> {
        val elements =
            graph.services.map { Triple(it.path, it.pathSegments, it.pooler?.poolSize ?: it.handlers) } +
                graph.calls.map { Triple(it.path, it.pathSegments, it.pool?.size) } +
                graph.routes.map { Triple(it.path, it.pathSegments, null) }
        return faults
            .flatMap { fault ->
                val targets =
                    elements.filter { (path, segments) ->
                        path == fault.target || segments.dropLast(1).singleOrNull() == fault.target
                    }
                if (targets.isEmpty()) {
                    sink.error(
                        CoreMessage.FAULT_TARGET,
                        "Fault target '${fault.target}' is not a service, database, pooler, replica, call or route",
                        fault.origin.document,
                        fault.origin.pointer + "/target",
                        fault.target,
                        variant,
                        args = mapOf("target" to JsonPrimitive(fault.target)),
                    )
                }
                targets.mapNotNull { (path, segments, nominalCapacity) ->
                    if (fault.kind == FaultKind.CAPACITY_LOSS && nominalCapacity == null) {
                        sink.error(
                            CoreMessage.FAULT_CAPACITY_TARGET,
                            "Fault target '$path' has no slot pool",
                            fault.origin.document,
                            fault.origin.pointer + "/target",
                            path,
                            variant,
                            args = mapOf("target" to JsonPrimitive(path)),
                        )
                        null
                    } else if (fault.kind == FaultKind.CAPACITY_LOSS && requireNotNull(fault.capacity) > requireNotNull(nominalCapacity)) {
                        sink.error(
                            CoreMessage.PARAM_MAXIMUM,
                            "Parameter 'capacity' is out of range: <= $nominalCapacity",
                            fault.origin.document,
                            fault.origin.pointer + "/capacity",
                            path,
                            variant,
                            args = mapOf("parameter" to JsonPrimitive("capacity"), "maximum" to JsonPrimitive(nominalCapacity)),
                        )
                        null
                    } else {
                        fault.copy(targetSegments = segments)
                    }
                }
            }.sortedWith(
                compareBy(
                    { it.target },
                    { it.fromMs },
                    { it.toMs },
                    { it.kind },
                    { it.multiplier },
                    { it.delayMs },
                    { it.failureProbability },
                    { it.capacity },
                ),
            )
    }

    private fun checkVariants(
        experiment: ExperimentFile,
        document: String,
        sink: Diagnostics,
    ) {
        if (experiment.variants.isEmpty()) {
            sink.error(CoreMessage.VARIANT_EMPTY, "The experiment must define at least one variant", document, "/variants")
        }
        val seen = mutableSetOf<String>()
        experiment.variants.forEachIndexed { index, variant ->
            val pointer = JsonPointer.of("variants", index, "id")
            if (!ID.matches(variant.id)) {
                sink.error(
                    CoreMessage.ID_VARIANT,
                    "Variant id '${variant.id}' must match ${ID.pattern}",
                    document,
                    pointer,
                    variant = variant.id,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(variant.id),
                            "pattern" to JsonPrimitive(ID.pattern),
                        ),
                )
            }
            if (!seen.add(variant.id)) {
                sink.error(
                    CoreMessage.VARIANT_DUPLICATE,
                    "Variant id '${variant.id}' is repeated",
                    document,
                    pointer,
                    variant = variant.id,
                    args =
                        mapOf(
                            "id" to JsonPrimitive(variant.id),
                        ),
                )
            }
        }
    }

    private fun duration(
        text: String,
        pointer: String,
        document: String,
        sink: Diagnostics,
        allowZero: Boolean,
    ): Double? {
        val value = Quantities.parse(text, Dimension.DURATION)
        if (value == null) {
            sink.error(
                CoreMessage.QUANTITY_DURATION,
                "'$text' is not a duration such as 250ms or 2s",
                document,
                pointer,
                args =
                    mapOf(
                        "value" to JsonPrimitive(text),
                    ),
            )
            return null
        }
        if (!allowZero && value <= 0.0) {
            sink.error(CoreMessage.EXECUTION_DURATION, "Duration must be greater than zero", document, pointer)
            return null
        }
        return value
    }

    companion object {
        /** Largest seed that a browser reads without loss (ADR 0005, item 10). */
        const val MAX_SEED: Long = 9_007_199_254_740_991L

        /** Block, connection and variant ids: path segments without `/` or `.`. */
        val ID: Regex = Regex("^[A-Za-z0-9][A-Za-z0-9_-]*$")
    }
}
