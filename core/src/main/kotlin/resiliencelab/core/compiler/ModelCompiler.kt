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
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.Origin
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
 * one client, one request, reachable services and no cycles — is checked.
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
        val faults = faults(experiment, model, experimentDocument, sink)
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
                            buildGraph(patched.model, modelDocument, patched.origins, sink, structureOk)
                                ?: return@mapIndexedNotNull null
                        run?.let {
                            CompiledPoint(
                                "p$pointIndex",
                                point.associate { it.path to it.value },
                                GraphIr(parts.client, parts.entry, parts.services, parts.calls, faults, it).let { graph ->
                                    graph.copy(
                                        services = graph.topologicalServices.map { node -> node.copy(scenario = graph.scenario(node)) },
                                        calls = graph.topologicalCalls,
                                    )
                                },
                                patched.origins
                                    .flatMap { (path, origins) ->
                                        origins.pointers.map { (parameter, pointer) ->
                                            "$path.$parameter" to Origin(origins.document, pointer)
                                        }
                                    }.toMap(),
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
        val client: ClientNode,
        val entry: String,
        val services: List<ServiceNode>,
        val calls: List<CallEdge>,
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
            if (from != null && to != null && rule != null && (from.type != rule.fromType || to.type != rule.toType)) {
                sink.error(
                    CoreMessage.CONNECTION_TYPE,
                    "Connection type '${type.id}' must connect ${rule.fromType} to ${rule.toType}",
                    document,
                    "$pointer/type",
                    connection.id,
                    args =
                        mapOf(
                            "type" to JsonPrimitive(type.id),
                            "fromType" to JsonPrimitive(rule.fromType),
                            "toType" to JsonPrimitive(rule.toType),
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
    ): GraphParts? {
        val before = sink.errorCount()
        val clients = model.blocks.filterValues { it.type == "client" }.toSortedMap()
        val services = model.blocks.filterValues { it.type == "service" }.toSortedMap()
        val clientNodes = clients.map { (id, block) -> readClient(id, block.params, document, origins[id], sink) }
        val outgoing = model.connections.filter { it.type == "call" }.groupBy { it.from }
        val serviceNodes =
            services.map { (id, block) ->
                val steps = readScenario(id, block.scenario, outgoing[id].orEmpty().map { it.id }.toSet(), document, sink)
                readService(id, block.params, document, origins[id], sink)?.copy(scenario = steps)
            }
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
        if (clients.size != 1) {
            sink.error(
                CoreMessage.TOPOLOGY_CLIENT,
                "The model must contain exactly one client block; found ${clients.size}",
                document,
                "/blocks",
                args =
                    mapOf(
                        "found" to JsonPrimitive(clients.size),
                    ),
            )
        }
        if (requests.size != 1 || requests.single().value.from !in clients) {
            sink.error(CoreMessage.GRAPH_REQUEST, "Exactly one request connection must start at the client", document, "/connections")
        }
        val entry = requests.singleOrNull()?.value?.to
        checkGraph(entry?.takeIf { it in services }, services.keys, calls, document, sink)
        if (!structureOk || sink.errorCount() > before) return null
        return GraphParts(clientNodes.single()!!, entry!!, serviceNodes.map { it!! }, callEdges.map { it!! })
    }

    private fun checkGraph(
        entry: String?,
        services: Set<String>,
        calls: List<IndexedValue<ConnectionInstance>>,
        document: String,
        sink: Diagnostics,
    ) {
        val validOutgoing = calls.filter { it.value.from in services && it.value.to in services }.groupBy { it.value.from }
        calls.filter { it.value.to == entry }.forEach { (index, call) ->
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
        if (entry == null) return
        val reachable = mutableSetOf<String>()
        val pending = ArrayDeque<String>()
        pending.addLast(entry)
        while (pending.isNotEmpty()) {
            val current = pending.removeFirst()
            if (reachable.add(current)) validOutgoing[current].orEmpty().forEach { pending.addLast(it.value.to) }
        }
        (services - reachable).sorted().forEach {
            sink.error(
                CoreMessage.GRAPH_UNREACHABLE,
                "Service '$it' is not reachable from the client",
                document,
                JsonPointer.of("blocks", it),
                it,
                args =
                    mapOf(
                        "service" to JsonPrimitive(it),
                    ),
            )
        }
    }

    private fun readScenario(
        id: String,
        steps: List<ScenarioStep>?,
        outgoing: Set<String>,
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
                        ServiceStep.Call(requireNotNull(connection))
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
    ): ClientNode? {
        val reader =
            reader("client", TypeCategory.BLOCK, params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
                ?: return null
        val rate = reader.quantity("rate")
        val deadline = reader.quantity("deadline")
        if (rate != null && !(1.0 / rate).isFinite()) {
            return reader.fail(
                CoreMessage.PARAM_RATE_INTERVAL,
                "rate",
                "Arrival rate is too small: the mean interval between requests is not finite",
            )
        }
        if (rate == null || deadline == null) return null
        return ClientNode(id, rate, deadline, Origin(document, JsonPointer.of("blocks", id)))
    }

    private fun readService(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): ServiceNode? {
        val reader =
            reader("service", TypeCategory.BLOCK, params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
                ?: return null
        val handlers = reader.int("handlers")
        val queue = reader.int("queue")
        val processing = reader.obj("processing")?.let(::distribution)
        val failure = reader.quantity("failureRate")
        return if (handlers == null || queue == null || processing == null || failure == null) {
            null
        } else {
            ServiceNode(id, handlers, queue, processing, failure, Origin(document, JsonPointer.of("blocks", id)))
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
        return if (network == null || timeout == null || attempts == null || backoff == null) {
            null
        } else {
            val origin = Origin(document, JsonPointer.of("connections", index))
            CallEdge(connection.id, connection.from, connection.to, network, timeout, attempts, backoff, origin)
        }
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
    ): List<FaultSpan> {
        val spans =
            experiment.faults.mapIndexedNotNull { index, fault ->
                val pointer = JsonPointer.of("faults", index)
                val before = sink.errorCount()
                if (model.blocks[fault.target]?.type != "service") {
                    sink.error(
                        CoreMessage.FAULT_TARGET,
                        "Fault target '${fault.target}' is not a service",
                        document,
                        "$pointer/target",
                        fault.target,
                        args =
                            mapOf(
                                "target" to JsonPrimitive(fault.target),
                            ),
                    )
                }
                val from = duration(fault.from, "$pointer/from", document, sink, allowZero = true)
                val to = duration(fault.to, "$pointer/to", document, sink, allowZero = false)
                if (from != null && to != null && to <= from) {
                    sink.error(CoreMessage.FAULT_INTERVAL, "Fault must end after it starts", document, "$pointer/to", fault.target)
                }
                val multiplier = fault.processingMultiplier
                if (multiplier != null && !(multiplier > 0.0 && multiplier.isFinite())) {
                    sink.error(
                        CoreMessage.PARAM_PROCESSING_MULTIPLIER,
                        "processingMultiplier must be greater than zero",
                        document,
                        "$pointer/processingMultiplier",
                        fault.target,
                    )
                }
                val failure =
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
                if (multiplier == null && fault.failureRate == null) {
                    sink.error(
                        CoreMessage.FAULT_EMPTY,
                        "Fault must set processingMultiplier or failureRate",
                        document,
                        pointer,
                        fault.target,
                    )
                }
                if (sink.errorCount() > before) {
                    null
                } else {
                    FaultSpan(fault.target, from!!, to!!, multiplier, failure, Origin(document, pointer))
                }
            }
        spans.groupBy { it.target }.forEach { (target, list) ->
            val overlap = list.sortedBy { it.fromMs }.zipWithNext().any { (first, second) -> second.fromMs < first.toMs }
            if (overlap) {
                sink.error(
                    CoreMessage.FAULT_OVERLAP,
                    "Faults on '$target' overlap in time",
                    document,
                    "/faults",
                    target,
                    args =
                        mapOf(
                            "target" to JsonPrimitive(target),
                        ),
                )
            }
        }
        return spans.sortedWith(compareBy({ it.target }, { it.fromMs }))
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
