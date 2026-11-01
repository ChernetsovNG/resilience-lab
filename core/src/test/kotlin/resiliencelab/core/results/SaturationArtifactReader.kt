package resiliencelab.core.results

import kotlinx.serialization.json.Json
import resiliencelab.core.workspace.Workspace
import java.util.zip.GZIPInputStream

/** Rebuilds one replication's degradation path from its persisted series, holding at most one decoded part. */
class SaturationArtifactReader(
    private val workspace: Workspace,
) {
    private val json = Json

    fun read(
        directory: String,
        replication: Int,
        callChain: List<String>,
        labels: Map<String, Map<String, SlotPoolLabel>> = emptyMap(),
        positions: Map<String, Int> = callChain.withIndex().associate { it.value to it.index },
    ): ReplicationSaturation {
        val index = json.decodeFromString(SeriesIndex.serializer(), workspace.read("$directory/index.json").text)
        val windows =
            sequence {
                index.parts.filter { it.kind == SeriesPartKind.INSTANCE }.forEach { reference ->
                    val compressed = workspace.readBytes("$directory/${reference.file}")
                    val bytes = GZIPInputStream(compressed.inputStream()).use { it.readAllBytes() }
                    val part = json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8))
                    part.nodes.forEach { node ->
                        node.windows.forEach { metrics -> yield(NodeWindow(node.id, metrics)) }
                    }
                    part.connections.forEach { connection ->
                        connection.windows.forEach { metrics ->
                            yield(
                                NodeWindow(
                                    connection.id,
                                    WindowMetrics(metrics.startMs, metrics.durationMs, slotPools = metrics.slotPools),
                                ),
                            )
                        }
                    }
                }
            }
        return SaturationAnalyzer.detect(replication, windows, labels = labels, positions = positions)
    }
}
