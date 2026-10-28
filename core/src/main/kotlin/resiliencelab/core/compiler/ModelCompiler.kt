package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Dimension
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.ParamKind
import resiliencelab.core.catalog.Quantities
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.catalog.TypeCategory
import resiliencelab.core.document.ConnectionInstance
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Variant
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import kotlin.math.ceil

/** One compiled variant. */
data class CompiledVariant(
    val id: String,
    val label: String,
    val chain: ChainIr,
)

/** All variants of an experiment with shared run settings. */
data class CompiledExperiment(
    val variants: List<CompiledVariant>,
    val run: RunSettings,
)

/** Compiler output: an experiment when there are no errors, and all diagnostics. */
data class CompileResult(
    val experiment: CompiledExperiment?,
    val diagnostics: List<Diagnostic>,
)

/**
 * Compiles a model and an experiment into one chain IR per variant (ADR 0002; stage 1 design §3–4):
 * variant overrides are applied by path, parameters are read against the catalog and the stage 1 topology —
 * one client, one request to the entry service and a linear chain of calls — is checked.
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
        val variants =
            experiment.variants.mapIndexedNotNull { index, variant ->
                val patched = applyOverrides(model, variant, index, experimentDocument, sink)
                val parts = buildChain(patched.model, modelDocument, patched.origins, sink, structureOk) ?: return@mapIndexedNotNull null
                run?.let {
                    CompiledVariant(
                        id = variant.id,
                        label = variant.label ?: variant.id,
                        chain = ChainIr(parts.client, parts.entry, parts.services, parts.calls, faults, it),
                    )
                }
            }
        val diagnostics = sink.items.distinct()
        val failed = diagnostics.any { it.severity == Severity.ERROR } || run == null
        return CompileResult(if (failed) null else CompiledExperiment(variants, run), diagnostics)
    }

    /** A variant's model and, per element, where its overridden values come from. */
    private class Patched(
        val model: ModelFile,
        val origins: Map<String, OverrideOrigins>,
    )

    private class ChainParts(
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
            if (!ID.matches(id)) sink.error("ID_INVALID", "Block id '$id' must match ${ID.pattern}", document, pointer, id)
            val type = catalog.type(block.type)
            if (type == null || type.category != TypeCategory.BLOCK) {
                sink.error("TYPE_UNKNOWN", "Unknown block type '${block.type}'", document, JsonPointer.child(pointer, "type"), id)
            }
        }
        val used = model.blocks.keys.toMutableSet()
        model.connections.forEachIndexed { index, connection ->
            val pointer = JsonPointer.of("connections", index)
            if (!ID.matches(connection.id)) {
                val message = "Connection id '${connection.id}' must match ${ID.pattern}"
                sink.error("ID_INVALID", message, document, "$pointer/id", connection.id)
            }
            if (!used.add(connection.id)) {
                sink.error("ID_DUPLICATE", "Id '${connection.id}' is already used", document, "$pointer/id", connection.id)
            }
            val type = catalog.type(connection.type)
            if (type == null || type.category != TypeCategory.CONNECTION) {
                sink.error("TYPE_UNKNOWN", "Unknown connection type '${connection.type}'", document, "$pointer/type", connection.id)
                return@forEachIndexed
            }
            val from = model.blocks[connection.from]
            val to = model.blocks[connection.to]
            if (from == null) {
                sink.error("CONNECTION_ENDPOINT", "Unknown source block '${connection.from}'", document, "$pointer/from", connection.id)
            }
            if (to == null) {
                sink.error("CONNECTION_ENDPOINT", "Unknown target block '${connection.to}'", document, "$pointer/to", connection.id)
            }
            val rule = type.connects
            if (from != null && to != null && rule != null && (from.type != rule.fromType || to.type != rule.toType)) {
                sink.error(
                    "CONNECTION_TYPE",
                    "Connection type '${type.id}' must connect ${rule.fromType} to ${rule.toType}",
                    document,
                    "$pointer/type",
                    connection.id,
                )
            }
        }
        return sink.errorCount() == before
    }

    /** Applies overrides in key order, so an object comes before its fields whatever the document order; web does the same. */
    private fun applyOverrides(
        model: ModelFile,
        variant: Variant,
        index: Int,
        document: String,
        sink: Diagnostics,
    ): Patched {
        var blocks = model.blocks
        val connections = model.connections.toMutableList()
        val pointers = mutableMapOf<String, MutableMap<String, String>>()
        variant.overrides.toSortedMap().forEach { (path, value) ->
            val segments = path.split('.')
            val target = segments.first()
            val paramPath = segments.drop(1)
            val block = blocks[target]
            val connectionIndex = connections.indexOfFirst { it.id == target }
            val typeId = block?.type ?: connections.getOrNull(connectionIndex)?.type
            val descriptors = typeId?.let { catalog.type(it)?.params }
            if (descriptors == null || paramPath.isEmpty() || !resolves(descriptors, paramPath)) {
                sink.error(
                    "OVERRIDE_PATH",
                    "Override '$path' does not name a parameter of a block or connection",
                    document,
                    JsonPointer.of("variants", index, "overrides", path),
                    target,
                )
                return@forEach
            }
            if (block != null) {
                blocks = blocks + (target to block.copy(params = setIn(block.params, descriptors, paramPath, value)))
            } else {
                val connection = connections[connectionIndex]
                connections[connectionIndex] = connection.copy(params = setIn(connection.params, descriptors, paramPath, value))
            }
            pointers.getOrPut(target) { mutableMapOf() }[paramPath.joinToString(".")] =
                JsonPointer.of("variants", index, "overrides", path)
        }
        return Patched(model.copy(blocks = blocks, connections = connections), pointers.mapValues { OverrideOrigins(document, it.value) })
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

    private fun buildChain(
        model: ModelFile,
        document: String,
        origins: Map<String, OverrideOrigins>,
        sink: Diagnostics,
        structureOk: Boolean,
    ): ChainParts? {
        val before = sink.errorCount()
        val clients = model.blocks.filterValues { it.type == "client" }.toSortedMap()
        val services = model.blocks.filterValues { it.type == "service" }.toSortedMap()
        val clientNodes = clients.map { (id, block) -> readClient(id, block.params, document, origins[id], sink) }
        val serviceNodes = services.map { (id, block) -> readService(id, block.params, document, origins[id], sink) }
        val indexed = model.connections.withIndex()
        val requests = indexed.filter { it.value.type == "request" }
        requests.forEach { (index, connection) ->
            // A request has no parameters; reading them against the catalog reports any that are written.
            reader("request", connection.params, document, JsonPointer.of("connections", index, "params"), connection.id, sink)
        }
        val calls = indexed.filter { it.value.type == "call" }.sortedBy { it.value.id }
        val callEdges = calls.map { (index, connection) -> readCall(index, connection, document, origins[connection.id], sink) }
        if (clients.size != 1) {
            sink.error("TOPOLOGY_CLIENT", "The model must contain exactly one client block; found ${clients.size}", document, "/blocks")
        }
        if (requests.size != 1 || requests.single().value.from !in clients) {
            sink.error("TOPOLOGY_CHAIN", "Exactly one request connection must start at the client", document, "/connections")
        }
        val entry = requests.singleOrNull()?.value?.to
        checkChain(entry?.takeIf { it in services }, services.keys, calls.map { it.value }, document, sink)
        if (!structureOk || sink.errorCount() > before) return null
        return ChainParts(clientNodes.single()!!, entry!!, serviceNodes.map { it!! }, callEdges.map { it!! })
    }

    private fun checkChain(
        entry: String?,
        services: Set<String>,
        calls: List<ConnectionInstance>,
        document: String,
        sink: Diagnostics,
    ) {
        val outgoing = calls.filter { it.from in services }.groupBy { it.from }
        val incoming = calls.filter { it.to in services }.groupBy { it.to }
        val validOutgoing = calls.filter { it.from in services && it.to in services }.groupBy { it.from }
        outgoing.filterValues { it.size > 1 }.keys.sorted().forEach {
            sink.error("TOPOLOGY_CHAIN", "Service '$it' has more than one outgoing call", document, JsonPointer.of("blocks", it), it)
        }
        incoming.filterValues { it.size > 1 }.keys.sorted().forEach {
            sink.error("TOPOLOGY_CHAIN", "Service '$it' has more than one incoming call", document, JsonPointer.of("blocks", it), it)
        }
        if (entry != null && entry in incoming) {
            sink.error("TOPOLOGY_CHAIN", "Entry service '$entry' must not receive calls", document, JsonPointer.of("blocks", entry), entry)
        }
        val visited = mutableSetOf<String>()
        val active = mutableSetOf<String>()
        services.sorted().forEach { start ->
            if (!visited.add(start)) return@forEach
            active.add(start)
            val pending = ArrayDeque<Pair<String, Iterator<ConnectionInstance>>>()
            pending.addLast(start to validOutgoing[start].orEmpty().iterator())
            while (pending.isNotEmpty()) {
                val (current, edges) = pending.last()
                if (!edges.hasNext()) {
                    active.remove(current)
                    pending.removeLast()
                    continue
                }
                val next = edges.next().to
                if (next in active) {
                    sink.error("TOPOLOGY_CHAIN", "Calls form a cycle through '$next'", document, JsonPointer.of("blocks", next), next)
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
            if (reachable.add(current)) validOutgoing[current].orEmpty().forEach { pending.addLast(it.to) }
        }
        (services - reachable).sorted().forEach {
            sink.error("TOPOLOGY_CHAIN", "Service '$it' is not reachable from the client", document, JsonPointer.of("blocks", it), it)
        }
    }

    private fun readClient(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): ClientNode? {
        val reader = reader("client", params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides) ?: return null
        val rate = reader.quantity("rate")
        val deadline = reader.quantity("deadline")
        if (rate != null && !(1.0 / rate).isFinite()) {
            return reader.fail("PARAM_RANGE", "rate", "Arrival rate is too small: the mean interval between requests is not finite")
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
        val reader = reader("service", params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides) ?: return null
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
        val reader = reader("call", connection.params, document, pointer, connection.id, sink, overrides) ?: return null
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
            reader.fail<Unit>("PARAM_MISSING", "stdDev", "lognormal requires stdDev")
        }
        if (kind == null || mean == null) return null
        if (kind != "lognormal" && reader.has("stdDev")) {
            return reader.fail("DISTRIBUTION_RULE", "stdDev", "stdDev applies only to lognormal")
        }
        if (kind != "fixed" && mean <= 0.0) {
            return reader.fail("PARAM_RANGE", "mean", "mean must be greater than zero for $kind")
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
        params: JsonObject,
        document: String,
        pointer: String,
        path: String,
        sink: Diagnostics,
        overrides: OverrideOrigins? = null,
    ): ParamReader? =
        catalog.type(type)?.let {
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
            sink.error("EXECUTION_RANGE", "replications must be at least 1", document, "/execution/replications")
        }
        val warmup = duration(execution.warmup, "/execution/warmup", document, sink, allowZero = true)
        val measurement = duration(execution.measurement, "/execution/measurement", document, sink, allowZero = false)
        val maxRealTime = duration(execution.maxRealTime, "/execution/maxRealTime", document, sink, allowZero = false)
        if (execution.seed !in 0L..MAX_SEED) {
            sink.error("SEED_RANGE", "seed must be an integer from 0 to $MAX_SEED", document, "/execution/seed")
        }
        if (warmup != null && measurement != null && !(warmup + measurement).isFinite()) {
            sink.error("EXECUTION_RANGE", "warmup plus measurement must be finite", document, "/execution/measurement")
        }
        if (sink.errorCount() > before || warmup == null || measurement == null || maxRealTime == null) return null
        return RunSettings(
            execution.replications,
            warmup,
            measurement,
            execution.seed,
            ceil(maxRealTime / 1_000.0).toLong().coerceAtLeast(1L),
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
                    sink.error("FAULT_TARGET", "Fault target '${fault.target}' is not a service", document, "$pointer/target", fault.target)
                }
                val from = duration(fault.from, "$pointer/from", document, sink, allowZero = true)
                val to = duration(fault.to, "$pointer/to", document, sink, allowZero = false)
                if (from != null && to != null && to <= from) {
                    sink.error("FAULT_INTERVAL", "Fault must end after it starts", document, "$pointer/to", fault.target)
                }
                val multiplier = fault.processingMultiplier
                if (multiplier != null && !(multiplier > 0.0 && multiplier.isFinite())) {
                    sink.error(
                        "PARAM_RANGE",
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
                                    "QUANTITY_INVALID",
                                    "failureRate must be a percentage from 0% to 100%",
                                    document,
                                    "$pointer/failureRate",
                                    fault.target,
                                )
                            }
                        }
                    }
                if (multiplier == null && fault.failureRate == null) {
                    sink.error("FAULT_EMPTY", "Fault must set processingMultiplier or failureRate", document, pointer, fault.target)
                }
                if (sink.errorCount() > before) {
                    null
                } else {
                    FaultSpan(fault.target, from!!, to!!, multiplier, failure, Origin(document, pointer))
                }
            }
        spans.groupBy { it.target }.forEach { (target, list) ->
            val overlap = list.sortedBy { it.fromMs }.zipWithNext().any { (first, second) -> second.fromMs < first.toMs }
            if (overlap) sink.error("FAULT_OVERLAP", "Faults on '$target' overlap in time", document, "/faults", target)
        }
        return spans.sortedWith(compareBy({ it.target }, { it.fromMs }))
    }

    private fun checkVariants(
        experiment: ExperimentFile,
        document: String,
        sink: Diagnostics,
    ) {
        if (experiment.variants.isEmpty()) {
            sink.error("VARIANT_EMPTY", "The experiment must define at least one variant", document, "/variants")
        }
        val seen = mutableSetOf<String>()
        experiment.variants.forEachIndexed { index, variant ->
            val pointer = JsonPointer.of("variants", index, "id")
            if (!ID.matches(variant.id)) sink.error("ID_INVALID", "Variant id '${variant.id}' must match ${ID.pattern}", document, pointer)
            if (!seen.add(variant.id)) sink.error("VARIANT_DUPLICATE", "Variant id '${variant.id}' is repeated", document, pointer)
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
            sink.error("QUANTITY_INVALID", "'$text' is not a duration such as 250ms or 2s", document, pointer)
            return null
        }
        if (!allowZero && value <= 0.0) {
            sink.error("EXECUTION_RANGE", "Duration must be greater than zero", document, pointer)
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
