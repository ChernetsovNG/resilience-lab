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
    fun `actual capacity clips warmup and restoration while all seven fields pool by sum`() {
        val base =
            requireNotNull(PoolerTestModel.compile(PoolerTestModel.withServicePool()).experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        val graph =
            base.copy(
                run = base.run.copy(warmupMs = 20.0, measurementMs = 100.0, windowMs = 70.0),
                faults =
                    listOf(
                        resiliencelab.core.ir.FaultSpan("gateway", 0.0, 60.0, resiliencelab.core.ir.FaultKind.CAPACITY_LOSS, capacity = 0),
                        resiliencelab.core.ir.FaultSpan(
                            "to-pooler",
                            40.0,
                            80.0,
                            resiliencelab.core.ir.FaultKind.CAPACITY_LOSS,
                            capacity = 1,
                        ),
                        resiliencelab.core.ir.FaultSpan("pooler", 60.0, 80.0, resiliencelab.core.ir.FaultKind.CAPACITY_LOSS, capacity = 0),
                        resiliencelab.core.ir.FaultSpan("db", 60.0, 120.0, resiliencelab.core.ir.FaultKind.CAPACITY_LOSS, capacity = 0),
                    ),
            )
        val rig = simulate(graph, emptyList())
        val result = rig.reliability.metrics.replicationResult()
        val json = Json.parseToJsonElement(DocumentCodec.encode(ReplicationResult.serializer(), result)).jsonObject
        val aggregate =
            resiliencelab.core.experiment.MetricsAggregator
                .aggregate(listOf(result, result))
        val pooled =
            Json
                .parseToJsonElement(
                    DocumentCodec.encode(
                        resiliencelab.core.experiment.AggregateMetrics
                            .serializer(),
                        aggregate,
                    ),
                ).jsonObject
        for ((kind, id, set, expected) in listOf(
            listOf("services", "gateway", "handlers", "6000"),
            listOf("services", "db", "handlers", "4000"),
            listOf("connections", "to-pooler", "pool", "160"),
            listOf("poolers", "pooler", "clientConnections", "200"),
            listOf("poolers", "pooler", "serverConnections", "80"),
        )) {
            val slot =
                json
                    .getValue(kind)
                    .jsonObject
                    .getValue(id)
                    .jsonObject
                    .getValue("slotPools")
                    .jsonObject
                    .getValue(set)
                    .jsonObject
            val total =
                pooled
                    .getValue(kind)
                    .jsonObject
                    .getValue(id)
                    .jsonObject
                    .getValue("totals")
                    .jsonObject
                    .getValue("slotPools")
                    .jsonObject
                    .getValue(set)
                    .jsonObject
            assertFields(slot, "capacityIntegralMs" to expected.toDouble())
            slot.forEach { (field, value) ->
                assertThat(total.getValue(field).jsonPrimitive.double).isEqualTo(value.jsonPrimitive.double * 2)
            }
        }
        val gateway = rig.windows.filter { it.id == "gateway" }.map { it.metrics.slotPools.getValue("handlers") }
        assertThat(gateway.map { it.capacityIntegralMs }).containsExactly(1000.0, 5000.0)
        val servers = rig.windows.filter { it.id == "pooler" }.map { it.metrics.slotPools.getValue("serverConnections") }
        assertThat(servers.map { it.capacityIntegralMs }).containsExactly(60.0, 40.0)
    }

    @Test
    fun `completed waits during runout belong to cohort totals but never extend window integrals`() {
        val base = graph(clients = 3, wait = "50ms")
        val rig = simulate(base.copy(run = base.run.copy(warmupMs = 5.0, measurementMs = 10.0, windowMs = 5.0)), listOf(4.0, 12.0, 13.0))
        val slot =
            pooler(rig)
                .getValue("slotPools")
                .jsonObject
                .getValue("serverConnections")
                .jsonObject
        assertFields(
            slot,
            "busyIntegralMs" to 10.0,
            "queueIntegralMs" to 4.0,
            "capacityIntegralMs" to 10.0,
            "waitCount" to 2.0,
            "totalWaitMs" to 13.0,
            "queueFullCount" to 0.0,
            "waitLimitCount" to 0.0,
        )
        val windows = rig.windows.filter { it.id == "pooler" }.map { it.metrics.slotPools.getValue("serverConnections") }
        assertThat(windows.sumOf { it.waitCount }).isEqualTo(1L)
        assertThat(windows.sumOf { it.totalWaitMs }).isEqualTo(2.0)
        assertThat(windows.sumOf { it.queueIntegralMs }).isEqualTo(4.0)
    }

    @Test
    fun `serialized slot roles share exactly seven fields and absent pools stay absent`() {
        val graph =
            requireNotNull(PoolerTestModel.compile(PoolerTestModel.withServicePool()).experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        val rig = simulate(graph, listOf(0.0, 1.0, 2.0, 21.0))
        val result =
            Json
                .parseToJsonElement(
                    DocumentCodec.encode(
                        ReplicationResult.serializer(),
                        rig.reliability.metrics.replicationResult(),
                    ),
                ).jsonObject
        val serviceRows = result.getValue("services").jsonObject
        val callRows = result.getValue("connections").jsonObject
        val poolerRow =
            result
                .getValue("poolers")
                .jsonObject
                .getValue("pooler")
                .jsonObject
        val slots =
            listOf(
                serviceRows
                    .getValue("gateway")
                    .jsonObject
                    .getValue("slotPools")
                    .jsonObject
                    .getValue("handlers"),
                serviceRows
                    .getValue("db")
                    .jsonObject
                    .getValue("slotPools")
                    .jsonObject
                    .getValue("handlers"),
                callRows
                    .getValue("to-pooler")
                    .jsonObject
                    .getValue("slotPools")
                    .jsonObject
                    .getValue("pool"),
                poolerRow.getValue("slotPools").jsonObject.getValue("clientConnections"),
                poolerRow.getValue("slotPools").jsonObject.getValue("serverConnections"),
            )
        slots.forEach { slot ->
            assertThat(slot.jsonObject.keys).containsExactlyInAnyOrder(
                "busyIntegralMs",
                "queueIntegralMs",
                "capacityIntegralMs",
                "waitCount",
                "totalWaitMs",
                "queueFullCount",
                "waitLimitCount",
            )
        }
        assertFields(slots[2].jsonObject, "waitCount" to 1.0, "totalWaitMs" to 4.0, "queueIntegralMs" to 4.0)
        assertThat(
            callRows
                .getValue("to-db")
                .jsonObject
                .getValue("slotPools")
                .jsonObject,
        ).isEmpty()
        assertThat(serviceRows.getValue("gateway").jsonObject).doesNotContainKeys("handlers", "busyHandlerTimeMs", "queueRejections")
        assertThat(
            rig.windows.first { it.id == graph.client.path }.metrics.let {
                Json
                    .parseToJsonElement(
                        DocumentCodec.encode(
                            resiliencelab.core.results.WindowMetrics
                                .serializer(),
                            it,
                        ),
                    ).jsonObject
                    .getValue("slotPools")
                    .jsonObject
            },
        ).isEmpty()
    }

    @Test
    fun `client limit rejects immediately while server wait timeout releases the admitted client`() {
        val rig = simulate(graph(), listOf(0.0, 1.0, 2.0))
        val metrics = pooler(rig)
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .entries.total.failuresByReason,
        ).containsExactlyEntriesOf(mapOf("queueFull" to 1, "waitLimit" to 1))
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

    @Test
    fun `service pool and transaction pooler wait independently reject by wait timeout and release connections`() {
        val source = PoolerTestModel.withServicePool()
        assertThat(source.blocks.getValue("db").type).isEqualTo("database")
        val compiled = PoolerTestModel.compile(source)
        assertThat(compiled.diagnostics).isEmpty()
        val graph =
            requireNotNull(compiled.experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        // The third request waits in the service pool until the second expires in the pooler at 6 ms.
        // It then waits for the server connection until 10 ms. The last request proves both pools are reusable.
        val rig = simulate(graph, listOf(0.0, 1.0, 2.0, 21.0))
        val result = rig.reliability.metrics.replicationResult()
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 6.0, 20.0, 31.0)
        val incoming = result.connections.getValue("to-pooler")
        assertThat(incoming.slotPools.getValue("pool").waitCount).isEqualTo(1)
        assertThat(incoming.slotPools.getValue("pool").totalWaitMs).isEqualTo(4.0)
        assertThat(incoming.slotPools.getValue("pool").queueIntegralMs).isEqualTo(4.0)
        assertThat(incoming.slotPools.getValue("pool").busyIntegralMs).isEqualTo(39.0)
        assertThat(incoming.slotPools.getValue("pool").capacityIntegralMs).isEqualTo(200.0)
        assertThat(incoming.slotPools.getValue("pool").waitLimitCount).isZero()
        assertThat(incoming.sentAttempts).isEqualTo(4)
        assertThat(incoming.succeeded).isEqualTo(3)
        assertThat(incoming.failed).isEqualTo(1)
        assertFields(
            pooler(rig),
            "offeredAttempts" to 4.0,
            "admittedAttempts" to 4.0,
            "successes" to 3.0,
            "failures" to 1.0,
            "clientConnectionRejections" to 0.0,
            "waitTimeouts" to 1.0,
            "serverWaitCount" to 2.0,
            "serverWaitTimeMs" to 9.0,
            "serverQueueLengthIntegralMs" to 9.0,
            "busyClientConnectionTimeMs" to 39.0,
            "busyServerConnectionTimeMs" to 30.0,
        )
        assertThat(result.services.getValue("db").admittedAttempts).isEqualTo(3)
        assertThat(
            result.services
                .getValue("db")
                .slotPools
                .getValue("handlers")
                .busyIntegralMs,
        ).isEqualTo(27.0)
        assertThat(result.connections.getValue("to-db").sentAttempts).isEqualTo(3)
        val rows = rig.windows.filter { it.id == "pooler" }.map { it.metrics.slotPools.getValue("serverConnections") }
        assertThat(rows.sumOf { it.waitLimitCount }).isEqualTo(1)
        assertThat(rows.sumOf { it.totalWaitMs }).isEqualTo(9.0)
        assertThat(rows.sumOf { it.busyIntegralMs }).isEqualTo(30.0)
        assertThat(rig.reliability.activeInvocations).isZero()
        assertThat(rig.reliability.activeOriginalRequests).isZero()
        assertThat(rig.reliability.activeDownstreamProcesses).isZero()
        rig.reliability.metrics.verifyConnectionsDrained()
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

    private fun field(
        metrics: JsonObject,
        name: String,
    ): kotlinx.serialization.json.JsonElement {
        val path =
            when (name) {
                "clientConnectionRejections" -> "clientConnections.queueFullCount"
                "waitTimeouts" -> "serverConnections.waitLimitCount"
                "busyClientConnectionTimeMs" -> "clientConnections.busyIntegralMs"
                "busyServerConnectionTimeMs" -> "serverConnections.busyIntegralMs"
                "serverQueueLengthIntegralMs" -> "serverConnections.queueIntegralMs"
                "serverWaitCount" -> "serverConnections.waitCount"
                "serverWaitTimeMs" -> "serverConnections.totalWaitMs"
                "clientConnectionCapacityTimeMs" -> "clientConnections.capacityIntegralMs"
                "serverConnectionCapacityTimeMs" -> "serverConnections.capacityIntegralMs"
                else -> return metrics.getValue(name)
            }
        return path.split('.').fold(metrics.getValue("slotPools")) { value, key -> value.jsonObject.getValue(key) }
    }

    private fun assertFields(
        metrics: JsonObject,
        vararg expected: Pair<String, Double>,
    ) {
        expected.forEach { (name, value) -> assertThat(field(metrics, name).jsonPrimitive.double).describedAs(name).isEqualTo(value) }
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
