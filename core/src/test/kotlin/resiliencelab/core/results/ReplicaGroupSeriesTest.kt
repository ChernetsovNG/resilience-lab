package resiliencelab.core.results

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.ReplicaGroup
import resiliencelab.core.experiment.ReplicaGroupKind
import resiliencelab.core.experiment.ReplicaMember
import resiliencelab.core.experiment.SlotPoolMetrics
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import kotlin.test.Test

class ReplicaGroupSeriesTest {
    @Test
    fun `index and part serialization retain required default row kind and empty membership`() {
        val index = SeriesIndex(6, 1.0, 1.0, listOf(SeriesPartReference("part-0.json.gz", listOf("client"), 0, 1, 10, "checksum")))
        val stored = Json.parseToJsonElement(DocumentCodec.encode(SeriesIndex.serializer(), index)).jsonObject
        assertThat(stored["groups"]).isEqualTo(JsonArray(emptyList()))
        assertThat(
            stored
                .getValue("parts")
                .jsonArray
                .single()
                .jsonObject["kind"],
        ).isEqualTo(JsonPrimitive("INSTANCE"))
        val part = SeriesPart(fromWindow = 0, untilWindow = 1, nodes = emptyList())
        val storedPart = Json.parseToJsonElement(DocumentCodec.encode(SeriesPart.serializer(), part)).jsonObject
        assertThat(storedPart["kind"]).isEqualTo(JsonPrimitive("INSTANCE"))
    }

    @Test
    fun `group and instance parts split independently with complete window coverage`(
        @TempDir root: Path,
    ) {
        FileWorkspace(root).use { workspace ->
            val groups =
                listOf("a", "b").map { id -> ReplicaGroup(id, ReplicaGroupKind.NODE, (1..3).map { ReplicaMember("$id#$it", it) }) } +
                    ReplicaGroup("call", ReplicaGroupKind.CONNECTION, (1..3).map { ReplicaMember("call#$it", it) })
            val directory = "series"
            val writer = SeriesWriter(workspace, directory, 4.0, 1.0, maxPartBytes = 2700, groups = groups)
            val nodeIds =
                listOf("client", "a", "b") +
                    groups.filter { it.kind == ReplicaGroupKind.NODE }.flatMap { it.instances.map { member -> member.id } }
            val callIds = listOf("call", "call#1", "call#2", "call#3")
            repeat(4) { window ->
                writer.writeWindow(
                    window,
                    nodeIds.map { id -> NodeWindow(id, WindowMetrics(window.toDouble(), 1.0)) },
                    callIds.map { id -> ConnectionWindow(id, ConnectionWindowMetrics(window.toDouble(), 1.0)) },
                )
            }
            val index = writer.finish()
            assertThat(index.groups).isEqualTo(groups)
            assertThat(index.parts.map { it.kind }.toSet()).containsExactlyInAnyOrder(SeriesPartKind.INSTANCE, SeriesPartKind.GROUP)
            assertThat(index.parts.filter { it.kind == SeriesPartKind.GROUP }.any { it.untilWindow - it.fromWindow > 1 }).isTrue()
            val coverage = mutableListOf<Pair<String, Int>>()
            index.parts.forEach { reference ->
                assertThat(reference.uncompressedBytes).isLessThanOrEqualTo(2700)
                val bytes = GZIPInputStream(workspace.readBytes("$directory/${reference.file}").inputStream()).use { it.readAllBytes() }
                assertThat(bytes.size).isEqualTo(reference.uncompressedBytes)
                val part = Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8))
                assertThat(part.kind).isEqualTo(reference.kind)
                val ids = part.nodes.map { it.id } + part.connections.map { it.id }
                if (part.kind == SeriesPartKind.GROUP) {
                    assertThat(ids).allMatch { '#' !in it && it != "client" }
                } else {
                    assertThat(ids).allMatch { '#' in it || it == "client" }
                }
                for (id in ids) for (window in part.fromWindow until part.untilWindow) coverage += id to window
            }
            assertThat(coverage).containsExactlyInAnyOrderElementsOf((nodeIds + callIds).flatMap { id -> (0..3).map { id to it } })
            assertThat(coverage.distinct()).hasSameSizeAs(coverage)
        }
    }

    @Test
    fun `saturation ignores group rows even when their sums cross the queue threshold`(
        @TempDir root: Path,
    ) {
        FileWorkspace(root).use { workspace ->
            val group = ReplicaGroup("worker", ReplicaGroupKind.NODE, (1..3).map { ReplicaMember("worker#$it", it) })
            val writer = SeriesWriter(workspace, "series", 3000.0, 1000.0, groups = listOf(group))
            repeat(3) { window ->
                val instance =
                    WindowMetrics(
                        window * 1000.0,
                        1000.0,
                        slotPools =
                            mapOf(
                                "handlers" to SlotPoolMetrics(busyIntegralMs = 1000.0, capacityIntegralMs = 1000.0, queueIntegralMs = 0.0),
                            ),
                    )
                val sum =
                    instance.copy(
                        slotPools =
                            mapOf(
                                "handlers" to
                                    SlotPoolMetrics(busyIntegralMs = 3000.0, capacityIntegralMs = 3000.0, queueIntegralMs = 30000.0),
                            ),
                    )
                writer.writeWindow(window, group.instances.map { NodeWindow(it.id, instance) } + NodeWindow("worker", sum))
            }
            writer.finish()
            val result = SaturationArtifactReader(workspace).read("series", 0, listOf("worker#1", "worker#2", "worker#3", "worker"))
            assertThat(result.degradationPath).isEmpty()
        }
    }
}
