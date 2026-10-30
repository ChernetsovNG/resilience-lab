package resiliencelab.core.engine.ksl

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.compiler.PoolerTestModel
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.results.NodeWindow
import kotlin.test.Test

class PoolerModelTest {
    @Test
    fun `client limit rejects immediately while server wait timeout releases the admitted client`() {
        val rig = simulate(graph(), listOf(0.0, 1.0, 2.0))
        val metrics = pooler(rig)
        assertFields(
            metrics,
            "offeredAttempts" to 3.0,
            "admittedAttempts" to 2.0,
            "clientConnectionRejections" to 1.0,
            "waitTimeouts" to 1.0,
            "successes" to 1.0,
            "failures" to 1.0,
            "busyClientConnectionTimeMs" to 15.0,
            "busyServerConnectionTimeMs" to 10.0,
            "serverQueueLengthIntegralMs" to 5.0,
            "serverWaitCount" to 1.0,
            "serverWaitTimeMs" to 5.0,
        )
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 6.0, 2.0)
        assertThat(
            metrics
                .getValue("latency")
                .jsonObject
                .getValue("count")
                .jsonPrimitive.double,
        ).isEqualTo(2.0)
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .services,
        ).doesNotContainKey("pooler")
    }

    @Test
    fun `server connection is held through delay and downstream response then serves its FIFO waiter`() {
        val rig = simulate(graph(wait = "20ms"), listOf(0.0, 1.0))
        assertFields(
            pooler(rig),
            "successes" to 2.0,
            "busyClientConnectionTimeMs" to 29.0,
            "busyServerConnectionTimeMs" to 20.0,
            "serverQueueLengthIntegralMs" to 9.0,
            "serverWaitTimeMs" to 9.0,
        )
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 20.0)
    }

    @Test
    fun `outgoing timeout frees the server connection while orphaned database work continues`() {
        val base = graph(wait = "30ms")
        val graph = base.copy(calls = base.calls.map { if (it.path == "to-db") it.copy(timeoutMs = 4.0) else it })
        val rig = simulate(graph, listOf(0.0, 1.0, 6.0))
        assertFields(
            pooler(rig),
            "admittedAttempts" to 3.0,
            "failures" to 3.0,
            "waitTimeouts" to 0.0,
            "busyServerConnectionTimeMs" to 15.0,
        )
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(5.0, 10.0, 15.0)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(result.connections.getValue("to-db").timeouts).isEqualTo(3)
        assertThat(result.connections.getValue("to-db").orphaned).isEqualTo(3)
        assertThat(rig.reliability.activeDownstreamProcesses).isZero()
    }

    @Test
    fun `upstream timeout does not release either pooler resource`() {
        val base = graph(clients = 1)
        val graph = base.copy(calls = base.calls.map { if (it.path == "to-pooler") it.copy(timeoutMs = 2.0) else it })
        val rig = simulate(graph, listOf(0.0, 3.0))
        assertFields(
            pooler(rig),
            "admittedAttempts" to 1.0,
            "clientConnectionRejections" to 1.0,
            "busyClientConnectionTimeMs" to 10.0,
            "busyServerConnectionTimeMs" to 10.0,
        )
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .connections
                .getValue("to-pooler")
                .orphaned,
        ).isEqualTo(1)
    }

    @Test
    fun `server release wins a simultaneous wait expiry`() {
        val rig = simulate(graph(wait = "9ms"), listOf(0.0, 1.0))
        assertFields(pooler(rig), "successes" to 2.0, "waitTimeouts" to 0.0, "serverWaitTimeMs" to 9.0)
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 20.0)
    }

    @Test
    fun `client connection remains held during the response network after server release`() {
        val base = graph(clients = 1)
        val graph = base.copy(calls = base.calls.map { if (it.path == "to-pooler") it.copy(network = TestChains.fixed(2.0)) else it })
        val rig = simulate(graph, listOf(0.0, 11.0))
        assertFields(
            pooler(rig),
            "admittedAttempts" to 1.0,
            "clientConnectionRejections" to 1.0,
            "busyClientConnectionTimeMs" to 12.0,
            "busyServerConnectionTimeMs" to 10.0,
        )
        assertThat(
            rig.invocations
                .first()
                .work.processCompletionTime,
        ).isEqualTo(14.0)
    }

    @Test
    fun `cohort includes runout waits while resource integrals include warmup work only within measurement`() {
        val base = graph(wait = "20ms")
        val graph = base.copy(run = base.run.copy(warmupMs = 5.0, measurementMs = 10.0, windowMs = 5.0))
        val rig = simulate(graph, listOf(0.0, 6.0))
        assertFields(
            pooler(rig),
            "offeredAttempts" to 1.0,
            "admittedAttempts" to 1.0,
            "successes" to 1.0,
            "busyClientConnectionTimeMs" to 14.0,
            "busyServerConnectionTimeMs" to 10.0,
            "serverQueueLengthIntegralMs" to 4.0,
            "serverWaitTimeMs" to 4.0,
        )
        assertThat(rig.windows.filter { it.id == "pooler" }.sumOf { it.metrics.offeredAttempts }).isEqualTo(2)
        assertThat(rig.windows.filter { it.id == "pooler" }.sumOf { it.metrics.successes }).isEqualTo(1)
    }

    @Test
    fun `pooler summary pools counters capacity time and latency without averaging percentiles`() {
        val first = simulate(graph(wait = "20ms"), listOf(0.0, 1.0)).reliability.metrics.replicationResult()
        val second = simulate(graph(wait = "20ms"), listOf(0.0)).reliability.metrics.replicationResult()
        val aggregate =
            resiliencelab.core.experiment.MetricsAggregator
                .aggregate(listOf(first, second))
        val json =
            Json
                .parseToJsonElement(
                    DocumentCodec.encode(
                        resiliencelab.core.experiment.AggregateMetrics
                            .serializer(),
                        aggregate,
                    ),
                ).jsonObject
        val row =
            json
                .getValue("poolers")
                .jsonObject
                .getValue("pooler")
                .jsonObject
        assertFields(
            row.getValue("totals").jsonObject,
            "offeredAttempts" to 3.0,
            "admittedAttempts" to 3.0,
            "successes" to 3.0,
            "busyClientConnectionTimeMs" to 39.0,
            "busyServerConnectionTimeMs" to 30.0,
            "clientConnectionCapacityTimeMs" to 400.0,
            "serverConnectionCapacityTimeMs" to 200.0,
            "serverWaitCount" to 1.0,
            "serverWaitTimeMs" to 9.0,
        )
        assertThat(
            row
                .getValue("pooledLatency")
                .jsonObject
                .getValue("meanMs")
                .jsonPrimitive.double,
        ).isEqualTo(13.0)
    }

    private fun graph(
        clients: Int = 2,
        wait: String = "5ms",
    ): GraphIr {
        val model = PoolerTestModel.model
        val pooler = model.blocks.getValue("pooler")
        val source =
            model.copy(
                blocks =
                    model.blocks + (
                        "pooler" to
                            pooler.copy(
                                params =
                                    JsonObject(
                                        pooler.params +
                                            mapOf("maxClientConnections" to JsonPrimitive(clients), "waitTimeout" to JsonPrimitive(wait)),
                                    ),
                            )
                    ),
            )
        return requireNotNull(PoolerTestModel.compile(source).experiment)
            .variants
            .single()
            .points
            .single()
            .graph
    }

    private fun pooler(rig: Rig): JsonObject =
        Json
            .parseToJsonElement(
                DocumentCodec.encode(ReplicationResult.serializer(), rig.reliability.metrics.replicationResult()),
            ).jsonObject
            .getValue("poolers")
            .jsonObject
            .getValue("pooler")
            .jsonObject

    private fun assertFields(
        metrics: JsonObject,
        vararg expected: Pair<String, Double>,
    ) {
        expected.forEach { (name, value) -> assertThat(metrics.getValue(name).jsonPrimitive.double).describedAs(name).isEqualTo(value) }
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double>,
    ): Rig {
        val model = Model("PoolerModelTest", autoCSVReports = false)
        val windows = mutableListOf<NodeWindow>()
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(model, graph, streams, onWindow = { _, nodes, _ -> windows += nodes })
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(model, name = "pooler-driver") {
            override fun initialize() {
                arrivals.forEach { arrival ->
                    invocations +=
                        reliability.invoke(
                            graph.entry,
                            arrival,
                            originalRequest = true,
                            measurementCohort = arrival >= graph.run.warmupMs,
                        )
                }
            }
        }
        model.numberOfReplications = 1
        model.lengthOfReplication = 250.0
        model.simulate()
        return Rig(reliability, invocations, windows)
    }

    private data class Rig(
        val reliability: ReliabilityModel,
        val invocations: List<ReliabilityModel.ServiceInvocation>,
        val windows: List<NodeWindow>,
    )
}
