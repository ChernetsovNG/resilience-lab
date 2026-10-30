package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.BlockInstance
import resiliencelab.core.document.ConnectionInstance
import resiliencelab.core.document.ScenarioStep
import resiliencelab.core.engine.ksl.AttemptOutcome
import resiliencelab.core.engine.ksl.PathStreamSource
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.ReliabilityModel
import resiliencelab.core.engine.ksl.StreamPlan
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.GraphIr
import kotlin.test.Test

class ReplicaSimulationTest {
    private val documents = ReplicaGroupsTest()

    @Test
    fun `an unused direct call cannot change policy on the active route into a group`() {
        val source =
            roundRobin().let { model ->
                val gateway = model.blocks.getValue("gateway")
                model.copy(
                    blocks =
                        model.blocks +
                            mapOf(
                                "router" to BlockInstance("router"),
                                "gateway" to
                                    gateway.copy(
                                        scenario = listOf(ScenarioStep("process"), ScenarioStep("call", connection = "gateway-to-worker")),
                                    ),
                            ),
                    connections =
                        model.connections.map { call ->
                            if (call.id !=
                                "gateway-to-worker"
                            ) {
                                call
                            } else {
                                call.copy(to = "router", params = JsonObject(call.params - "balancing"))
                            }
                        } + ConnectionInstance("route-to-worker", "route", "router", "worker"),
                )
            }
        val direct =
            source.connections.first { it.id == "gateway-to-worker" }.copy(
                id = "unused",
                to = "worker",
                params =
                    JsonObject(
                        mapOf(
                            "timeout" to JsonPrimitive("100ms"),
                            "balancing" to JsonPrimitive("random"),
                        ),
                    ),
            )
        val before = run(documents.graph(source), count = 30, spacing = 10.0).first
        val after = run(documents.graph(source.copy(connections = source.connections + direct)), count = 30, spacing = 10.0).first
        for (number in 1..3) {
            assertThat(before.services.getValue("worker#$number").offeredAttempts).isEqualTo(10)
            assertThat(after.services.getValue("worker#$number").offeredAttempts).isEqualTo(10)
        }
    }

    @Test
    fun `fault on replica two changes only its processing`() {
        val fault = documents.experiment("""[{"target":"worker#2","from":"0ms","to":"1s","kind":"slowdown","multiplier":5}]""")
        val graph = documents.graph(roundRobin(), fault)
        val (result, outcomes) = run(graph)
        assertThat(outcomes).containsExactly(AttemptOutcome.SUCCEEDED, AttemptOutcome.SUCCEEDED, AttemptOutcome.SUCCEEDED)
        assertThat(result.services.getValue("worker#1").busyHandlerTimeMs).isEqualTo(10.0)
        assertThat(result.services.getValue("worker#2").busyHandlerTimeMs).isEqualTo(26.0)
        assertThat(result.services.getValue("worker#3").busyHandlerTimeMs).isEqualTo(10.0)
    }

    @Test
    fun `group connection fault affects every copy without changing local work`() {
        val fault = documents.experiment("""[{"target":"worker-to-tail","from":"0ms","to":"1s","kind":"slowdown","multiplier":3}]""")
        val model =
            roundRobin().let { model ->
                model.copy(
                    connections =
                        model.connections.map { call ->
                            if (call.id !=
                                "worker-to-tail"
                            ) {
                                call
                            } else {
                                call.copy(
                                    params =
                                        JsonObject(
                                            call.params +
                                                (
                                                    "network" to
                                                        JsonObject(mapOf("kind" to JsonPrimitive("fixed"), "mean" to JsonPrimitive("1ms")))
                                                ),
                                        ),
                                )
                            }
                        },
                )
            }
        val (result, _) = run(documents.graph(model, fault))
        for (number in 1..3) {
            assertThat(result.services.getValue("worker#$number").busyHandlerTimeMs).isEqualTo(22.0)
            assertThat(result.connections.getValue("worker-to-tail#$number").sentAttempts).isEqualTo(2)
        }
    }

    @Test
    fun `two hundred millisecond delay on one outgoing copy slows only replica two`() {
        val fault =
            documents.experiment(
                """[{"target":"worker-to-tail#2","from":"0ms","to":"1s","kind":"slowdown","delay":"200ms"}]""",
            )
        val source =
            roundRobin().let { model ->
                val client = model.blocks.getValue("client")
                model.copy(
                    blocks =
                        model.blocks + (
                            "client" to client.copy(params = JsonObject(client.params + ("deadline" to JsonPrimitive("5s"))))
                        ),
                    connections =
                        model.connections.map { connection ->
                            if (connection.type == "call") {
                                connection.copy(params = JsonObject(connection.params + ("timeout" to JsonPrimitive("2s"))))
                            } else {
                                connection
                            }
                        },
                )
            }

        val (result, outcomes) = run(documents.graph(source, fault))

        assertThat(outcomes).containsExactly(AttemptOutcome.SUCCEEDED, AttemptOutcome.SUCCEEDED, AttemptOutcome.SUCCEEDED)
        assertThat((1..3).map { result.services.getValue("worker#$it").busyHandlerTimeMs }).containsExactly(10.0, 810.0, 10.0)
        // Two calls each hold the handler for another 200 ms in each network direction.
        assertThat(result.connections.getValue("worker-to-tail#2").sentAttempts).isEqualTo(2)
    }

    @Test
    fun `connection failure is retried without offering work to the downstream service`() {
        val fault = documents.experiment("""[{"target":"worker-to-tail","from":"0ms","to":"1s","kind":"errors","failureRate":"100%"}]""")
        val source =
            roundRobin().let { model ->
                model.copy(
                    connections =
                        model.connections.map { call ->
                            if (call.id !=
                                "worker-to-tail"
                            ) {
                                call
                            } else {
                                call.copy(params = JsonObject(call.params + ("attempts" to JsonPrimitive(2))))
                            }
                        },
                )
            }
        val graph = documents.graph(source, fault)
        val (result, outcomes) = run(graph)
        assertThat(outcomes).containsOnly(AttemptOutcome.DOWNSTREAM_FAILURE)
        assertThat(result.services.getValue("tail").offeredAttempts).isZero()
        assertThat(result.failures).isEqualTo(3)
        for (number in 1..3) {
            assertThat(result.connections.getValue("worker-to-tail#$number").sentAttempts).isEqualTo(2)
            assertThat(result.connections.getValue("worker-to-tail#$number").retries).isEqualTo(1)
        }
    }

    @Test
    fun `entry service can itself be a replica group`() {
        val source =
            documents.model(1).let { model ->
                val entry = model.blocks.getValue("gateway")
                model.copy(
                    blocks =
                        model.blocks + ("gateway" to entry.copy(params = JsonObject(entry.params + ("replicas" to JsonPrimitive(3))))),
                )
            }
        val compiled = requireNotNull(documents.compile(source).experiment)
        ModelLinter().lint(compiled)
        val graph =
            compiled.variants
                .single()
                .points
                .single()
                .graph
        val (result, outcomes) = run(graph)
        assertThat(outcomes).containsOnly(AttemptOutcome.SUCCEEDED)
        assertThat((1..3).map { result.services.getValue("gateway#$it").offeredAttempts }).containsExactly(1, 1, 1)
        assertThat(result.successes).isEqualTo(3)
    }

    private fun roundRobin() =
        documents.model(3).let { model ->
            model.copy(
                connections =
                    model.connections.map { call ->
                        if (call.id !=
                            "gateway-to-worker"
                        ) {
                            call
                        } else {
                            call.copy(params = JsonObject(call.params + ("balancing" to JsonPrimitive("roundRobin"))))
                        }
                    },
            )
        }

    private fun run(
        graph: GraphIr,
        count: Int = 3,
        spacing: Double = 100.0,
    ): Pair<ReplicationResult, List<AttemptOutcome>> {
        val simulation = Model("ReplicaSimulation", autoCSVReports = false)
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(simulation, graph, streams)
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(simulation, name = "replica-driver") {
            override fun initialize() {
                repeat(count) { index ->
                    schedule<Nothing>(
                        eventAction = { invocations += reliability.invoke(graph.entry, originalRequest = true) },
                        timeToEvent =
                            index * spacing,
                    )
                }
            }
        }
        simulation.numberOfReplications = 1
        simulation.lengthOfReplication = 1_100.0
        simulation.simulate()
        reliability.metrics.verifyConnectionsDrained()
        return reliability.metrics.replicationResult() to invocations.map { it.outcome }
    }
}
