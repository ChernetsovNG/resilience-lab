package resiliencelab.core.engine.ksl

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.ReplicaGroup
import resiliencelab.core.experiment.ReplicaGroupKind
import resiliencelab.core.experiment.ReplicaGroups
import resiliencelab.core.experiment.ReplicaMember
import resiliencelab.core.results.ConnectionWindow
import resiliencelab.core.results.ConnectionWindowMetrics
import resiliencelab.core.results.NodeWindow
import resiliencelab.core.results.WindowMetrics
import kotlin.test.Test

class WindowClientTotalsTest {
    @Test
    fun `every row carries all client arrivals for its own window including empty and short windows`() {
        val windows = mutableListOf<Pair<List<NodeWindow>, List<ConnectionWindow>>>()
        val group =
            ReplicaGroup(
                "calls",
                ReplicaGroupKind.CONNECTION,
                listOf(ReplicaMember("calls#1", 1), ReplicaMember("calls#2", 2)),
            )
        val collector =
            WindowCollector(
                clientId = "mobile",
                services = emptyList(),
                endMs = 2.5,
                windowMs = 1.0,
                connectionIds = listOf("calls#1", "calls#2"),
                clientIds = listOf("mobile", "partner"),
                classIds = listOf("status", "checkout"),
            ) { _, nodes, connections -> windows += nodes to connections }
        collector.originalArrival(0.1, "mobile", "status")
        collector.originalArrival(0.2, "partner", "status")
        collector.originalArrival(0.3, "partner", "checkout")
        collector.originalArrival(1.0, "mobile", "checkout")
        collector.originalArrival(2.5, "partner", "status")
        collector.finish()

        assertThat(windows).hasSize(3)
        windows.forEachIndexed { index, (nodes, connections) ->
            val expected = listOf(3, 1, 0)[index]
            assertThat(nodes.map { it.metrics.durationMs }).allMatch { it == if (index == 2) 0.5 else 1.0 }
            nodes.forEach { node ->
                val encoded = Json.parseToJsonElement(DocumentCodec.encode(WindowMetrics.serializer(), node.metrics)).jsonObject
                assertThat(
                    encoded["clientOriginalArrivals"],
                ).describedAs("node/class ${node.id} window $index").isEqualTo(JsonPrimitive(expected))
            }
            (connections + ReplicaGroups.connectionWindows(listOf(group), connections)).forEach { connection ->
                val encoded =
                    Json
                        .parseToJsonElement(DocumentCodec.encode(ConnectionWindowMetrics.serializer(), connection.metrics))
                        .jsonObject
                assertThat(
                    encoded["clientOriginalArrivals"],
                ).describedAs("connection ${connection.id} window $index").isEqualTo(JsonPrimitive(expected))
            }
        }
    }
}
