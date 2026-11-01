package resiliencelab.core.results

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.experiment.ReplicaGroupKind
import resiliencelab.core.experiment.ReplicaGroups
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.windowCount
import resiliencelab.core.workspace.Workspace
import java.util.zip.GZIPInputStream

/** Builds derived parts in replication order, retaining only source parts covering the current window. */
internal class AggregateSeriesWriter(
    private val workspace: Workspace,
) {
    private val json =
        Json {
            explicitNulls = false
            encodeDefaults = true
        }
    private val outputs = Stage1Catalog.catalog.types.associate { type -> type.id to type.outputs.filter { it.timeline != null } }

    fun write(
        runDirectory: String,
        compiled: CompiledExperiment,
    ) {
        for (variant in compiled.variants) {
            for (point in variant.points) {
                writePoint("$runDirectory/series/${variant.id}/${point.id}", point.graph, compiled.run.replications)
            }
        }
    }

    private fun writePoint(
        directory: String,
        graph: GraphIr,
        replications: Int,
    ) {
        val readers = (0 until replications).map { Reader("$directory/rep-$it") }
        val groups = ReplicaGroups.membership(graph)
        val nodeTypes =
            graph.clients.associate { it.path to "client" } +
                graph.services.associate { it.path to if (it.pooler != null) "pooler" else it.type }
        val allNodeTypes =
            nodeTypes +
                groups.filter { it.kind == ReplicaGroupKind.NODE }.associate { it.id to nodeTypes.getValue(it.instances.first().id) }
        val callTypes =
            graph.calls.associate { it.path to "call" } + graph.routes.associate { it.path to "route" } +
                groups.filter { it.kind == ReplicaGroupKind.CONNECTION }.associate { it.id to "call" }
        val endMs = graph.run.warmupMs + graph.run.measurementMs
        val writer =
            SeriesWriter(
                workspace,
                "$directory/aggregate",
                endMs,
                graph.run.windowMs,
                groups = groups,
                aggregateReplications = replications,
            )
        for (window in 0 until windowCount(endMs, graph.run.windowMs)) {
            val frames = readers.map { it.frame(window) }

            fun rows(
                population: Int,
                types: Map<String, String>,
            ): List<AggregateRowWindow> =
                frames.flatMap { it[population].keys }.distinct().sorted().mapNotNull { id ->
                    val type = types[id] ?: if (population == 2) "client" else ""
                    val descriptors = outputs[type].orEmpty()
                    if (descriptors.isEmpty()) return@mapNotNull null
                    val contexts = frames.map { frame -> frame[population][id] ?: JsonNull }
                    AggregateRowWindow(
                        id,
                        AggregateWindowMetrics(
                            descriptors.associate { output ->
                                output.id to AggregateOutputs.calculate(output.calculation, contexts)
                            },
                        ),
                    )
                }
            writer.writeAggregateWindow(window, rows(0, allNodeTypes), rows(1, callTypes), rows(2, emptyMap()))
        }
        writer.finish()
    }

    private inner class Reader(
        private val directory: String,
    ) {
        private val index = json.decodeFromString(SeriesIndex.serializer(), workspace.read("$directory/index.json").text)
        private val loaded = mutableMapOf<SeriesPartReference, SeriesPart>()

        fun frame(window: Int): List<Map<String, JsonElement>> {
            loaded.keys.removeAll { it.untilWindow <= window }
            val rows = List(3) { sortedMapOf<String, JsonElement>() }
            for (reference in index.parts.filter { window in it.fromWindow until it.untilWindow }) {
                val part =
                    loaded.getOrPut(reference) {
                        val text =
                            GZIPInputStream(
                                workspace.readBytes("$directory/${reference.file}").inputStream(),
                            ).bufferedReader().use { it.readText() }
                        json.decodeFromString(SeriesPart.serializer(), text)
                    }
                val offset = window - reference.fromWindow

                fun add(
                    population: Int,
                    id: String,
                    metrics: JsonElement,
                ) {
                    check(rows[population].put(id, metrics) == null) { "Duplicate row $id in window $window" }
                }
                part.nodes.forEach { add(0, it.id, json.encodeToJsonElement(WindowMetrics.serializer(), it.windows[offset])) }
                part.connections.forEach {
                    add(
                        1,
                        it.id,
                        json.encodeToJsonElement(ConnectionWindowMetrics.serializer(), it.windows[offset]),
                    )
                }
                part.classes.forEach { add(2, it.id, json.encodeToJsonElement(WindowMetrics.serializer(), it.windows[offset])) }
            }
            return rows
        }
    }
}
