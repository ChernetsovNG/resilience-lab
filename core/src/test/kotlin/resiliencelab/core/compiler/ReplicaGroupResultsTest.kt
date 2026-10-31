package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.engine.ksl.PathStreamSource
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.ReliabilityModel
import resiliencelab.core.engine.ksl.StreamPlan
import resiliencelab.core.results.NodeWindow
import resiliencelab.core.results.WindowMetrics
import kotlin.test.Test

class ReplicaGroupResultsTest {
    @Test
    fun `replication includes group sums beside replica statistics`() {
        val documents = ReplicaGroupsTest()
        val graph = documents.graph(documents.model(3, tailReplicas = 2))
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val result = ReliabilityModel(Model("GroupResults", autoCSVReports = false), graph, streams).runReplication()
        assertThat(result.services).containsKey("worker")
        val group = result.services.getValue("worker")
        val members = (1..3).map { result.services.getValue("worker#$it") }
        assertThat(group.offeredAttempts).isEqualTo(members.sumOf { it.offeredAttempts })
        assertThat(group.measurementMs).isEqualTo(graph.run.measurementMs)
        assertThat(group.slotPools.getValue("handlers").busyIntegralMs)
            .isEqualTo(members.sumOf { it.slotPools.getValue("handlers").busyIntegralMs })
        assertThat(result.connections).containsKey("worker-to-tail")
        assertThat(result.groups.map { it.id }).containsExactly("tail", "worker", "worker-to-tail")
        assertThat(
            result.groups
                .single { it.id == "worker-to-tail" }
                .instances
                .map { it.replica },
        ).containsExactly(1, 2, 3)
        assertThat(result.services).containsKey("tail")
    }

    @Test
    fun `slowdown of replica two names it as both utilization and queue maximum in emitted group windows`() {
        val documents = ReplicaGroupsTest()
        val source =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":6,"blocks":{
                    "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"300/s"}]},"deadline":"5s"}},
                    "worker":{"type":"service","params":{"replicas":3,"handlers":10,"queue":1000,
                        "processing":{"kind":"fixed","mean":"2ms"}},"replicaOverrides":{"2":{"handlers":1}}}
                },"connections":[{"id":"request","type":"request","from":"client","to":"worker"}]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val graph =
            documents.graph(
                source,
                documents.experiment(
                    """[{"target":"worker#2","from":"100ms","to":"900ms","kind":"slowdown","multiplier":20}]""",
                ),
            )
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val windows = mutableListOf<NodeWindow>()
        ReliabilityModel(
            Model("SlowReplicaGroup", autoCSVReports = false),
            graph,
            streams,
            onWindow = { _, nodes, _ -> windows += nodes },
        ).runReplication()

        val insideSlowdown = windows.filter { it.metrics.startMs == 500.0 }
        val group = insideSlowdown.single { it.id == "worker" }.metrics
        val serializedGroup = Json.parseToJsonElement(DocumentCodec.encode(WindowMetrics.serializer(), group)).jsonObject
        val clientArrivals = insideSlowdown.single { it.id == graph.client.path }.metrics.originalArrivals
        assertThat(serializedGroup["clientOriginalArrivals"]).isEqualTo(JsonPrimitive(clientArrivals))
        assertThat(group.originalArrivals).isEqualTo(
            insideSlowdown.filter { it.id in listOf("worker#1", "worker#2", "worker#3") }.sumOf { it.metrics.originalArrivals },
        )
        insideSlowdown.filter { it.id != "worker" }.forEach { row ->
            assertThat(row.metrics.clientOriginalArrivals).isNull()
        }
        val slots = group.slotPools.getValue("handlers")
        assertThat(group.startMs + group.durationMs).isLessThan(900.0)
        assertThat(slots.replicaExtrema!!.maxUtilizationReplica).isEqualTo(2)
        assertThat(slots.replicaExtrema.maxUtilization).isEqualTo(1.0)
        assertThat(slots.replicaExtrema.maxMeanQueueLengthReplica).isEqualTo(2)
        assertThat(slots.replicaExtrema.maxMeanQueueLength).isGreaterThan(0.0)
        for (number in listOf(1, 3)) {
            val replica =
                insideSlowdown
                    .single { it.id == "worker#$number" }
                    .metrics.slotPools
                    .getValue("handlers")
            assertThat(replica.queueIntegralMs).isZero()
            assertThat(replica.busyIntegralMs / replica.capacityIntegralMs).isLessThan(1.0)
        }
    }
}
