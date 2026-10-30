package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import ksl.utilities.random.rvariable.KSLRandom
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class GraphScenarioTest {
    @Test
    fun `sequential calls use their own request and response networks`() {
        val rig = simulate(graph())
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        // 3 local steps at 2 ms; A = 3 + 5 + 3; B = 7 + 11 + 7.
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(42.0)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(
            result.connections
                .getValue("a")
                .latency.sumMs,
        ).isEqualTo(11.0)
        assertThat(
            result.connections
                .getValue("b")
                .latency.sumMs,
        ).isEqualTo(25.0)
        assertThat(result.services.getValue("entry").admittedAttempts).isEqualTo(1)
    }

    @Test
    fun `same edge can be called twice without counting the second call as a retry`() {
        val rig = simulate(graph(listOf(ServiceStep.Call("a"), ServiceStep.Call("a"))))
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(22.0)
        val connection =
            rig.reliability.metrics
                .replicationResult()
                .connections
                .getValue("a")
        assertThat(connection.sentAttempts).isEqualTo(2)
        assertThat(connection.succeeded).isEqualTo(2)
        assertThat(connection.retries).isZero()
    }

    @Test
    fun `failed second call skips later processing and calls`() {
        val base =
            graph(listOf(ServiceStep.Process, ServiceStep.Call("a"), ServiceStep.Call("b"), ServiceStep.Process, ServiceStep.Call("a")))
        val rig = simulate(base.copy(services = base.services.map { if (it.path == "right") it.copy(failureProbability = 1.0) else it }))
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.DOWNSTREAM_FAILURE)
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(38.0)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(result.connections.getValue("a").sentAttempts).isEqualTo(1)
        assertThat(result.connections.getValue("b").failed).isEqualTo(1)
    }

    @Test
    fun `one handler stays allocated across every step and queues the next invocation`() {
        val rig = simulate(graph(), arrivals = listOf(0.0, 1.0))
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(42.0, 84.0)
        val entry =
            rig.reliability.metrics
                .replicationResult()
                .services
                .getValue("entry")
        assertThat(entry.busyHandlerTimeMs).isEqualTo(84.0)
        assertThat(entry.queueLengthIntegralMs).isEqualTo(41.0)
        assertThat(entry.admittedAttempts).isEqualTo(2)
    }

    @Test
    fun `local failure aborts before the next call`() {
        val base = graph()
        val rig = simulate(base.copy(services = base.services.map { if (it.path == "entry") it.copy(failureProbability = 1.0) else it }))
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.LOCAL_FAILURE)
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(2.0)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(result.connections.values.sumOf { it.sentAttempts }).isZero()
        assertThat(result.services.getValue("entry").failures).isEqualTo(1)
    }

    @Test
    fun `timed out child finishes its scenario while caller skips remaining steps`() {
        for (deadline in listOf(500.0, 6.0)) {
            val base = graph(listOf(ServiceStep.Call("a"), ServiceStep.Call("b")))
            val rig =
                simulate(
                    base.copy(
                        client = base.client.copy(deadlineMs = deadline),
                        services =
                            base.services.map {
                                if (it.path ==
                                    "left"
                                ) {
                                    it.copy(scenario = listOf(ServiceStep.Process, ServiceStep.Process))
                                } else {
                                    it
                                }
                            },
                        calls = base.calls.map { it.copy(timeoutMs = 6.0) },
                    ),
                )
            val caller = rig.invocations.single()
            assertThat(caller.outcome).isEqualTo(if (deadline == 6.0) AttemptOutcome.DEADLINE_EXCEEDED else AttemptOutcome.TIMED_OUT)
            assertThat(caller.work.processCompletionTime).isEqualTo(6.0)
            assertThat(
                caller.callAttempt!!
                    .child.work.processCompletionTime,
            ).isEqualTo(16.0)
            assertThat(caller.callAttempt!!.child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
            val result = rig.reliability.metrics.replicationResult()
            assertThat(result.connections.getValue("a").orphanedIntegralMs).isEqualTo(10.0)
            assertThat(result.connections.getValue("b").sentAttempts).isZero()
            assertThat(rig.reliability.activeDownstreamProcesses).isZero()
            assertThat(rig.reliability.activeInvocations).isZero()
            rig.reliability.metrics.verifyConnectionsDrained()
        }
    }

    @Test
    fun `target is selected again for retry and edge network follows the selected target`() {
        val base = graph(listOf(ServiceStep.Call("a")))
        val graph =
            base.copy(
                services = base.services.map { if (it.path == "left") it.copy(failureProbability = 1.0) else it },
                calls = base.calls.map { it.copy(attempts = 3, backoff = TestChains.fixedBackoff(4.0)) },
            )
        val selections = mutableListOf<Pair<String, Int>>()
        val rig =
            simulate(graph, selectTarget = { edge, number ->
                selections += edge.path to number
                if (number == 1) "left" else "right"
            })
        assertThat(selections).containsExactly("a" to 1, "a" to 2)
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        // Failed left (11), backoff (4), selected right through edge A (3 + 11 + 3).
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(32.0)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(result.connections.getValue("a").sentAttempts).isEqualTo(2)
        assertThat(result.connections.getValue("a").failed).isEqualTo(1)
        assertThat(result.connections.getValue("a").succeeded).isEqualTo(1)
        assertThat(result.connections.getValue("a").retries).isEqualTo(1)
        assertThat(result.connections.getValue("a").backoffIntegralMs).isEqualTo(4.0)
        assertThat(result.connections.getValue("b").sentAttempts).isZero()
        assertThat(result.services.getValue("left").offeredAttempts).isEqualTo(1)
        assertThat(result.services.getValue("right").offeredAttempts).isEqualTo(1)
    }

    @Test
    fun `repeated edge consumes successive network samples and restarts attempt numbering`() {
        val base = graph(listOf(ServiceStep.Call("a"), ServiceStep.Call("a")))
        val graph = base.copy(calls = base.calls.map { it.copy(network = TestChains.exponential(3.0)) })
        val network = TestChains.stream(graph.run.seed, "a", StreamRole.NETWORK)
        val expectedNetwork = (1..4).map { KSLRandom.rExponential(3.0, network) }
        val selections = mutableListOf<Int>()
        val rig =
            simulate(graph, selectTarget = { edge, number ->
                selections += number
                edge.to
            })
        assertThat(selections).containsExactly(1, 1)
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isCloseTo(
            10.0 + expectedNetwork.sum(),
            org.assertj.core.data.Offset
                .offset(1e-12),
        )
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .connections
                .getValue("a")
                .retries,
        ).isZero()
    }

    @Test
    fun `successive calls use independent edge jitter streams`() {
        val base = graph(listOf(ServiceStep.Call("a"), ServiceStep.Call("b")))
        val graph =
            base.copy(
                services = base.services.map { if (it.path == "left") it.copy(failureProbability = 1.0) else it },
                calls =
                    base.calls.map {
                        it.copy(
                            attempts = 2,
                            backoff = TestChains.backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 10.0, 20.0),
                        )
                    },
            )
        val jitterA = TestChains.stream(graph.run.seed, "a", StreamRole.JITTER).randU01() * 10.0
        val jitterB = TestChains.stream(graph.run.seed, "b", StreamRole.JITTER).randU01() * 10.0
        val rig = simulate(graph, selectTarget = { _, number -> if (number == 1) "left" else "right" })
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isCloseTo(
            72.0 + jitterA + jitterB,
            org.assertj.core.data.Offset
                .offset(1e-12),
        )
        val connections =
            rig.reliability.metrics
                .replicationResult()
                .connections
        assertThat(connections.getValue("a").backoffIntegralMs).isCloseTo(
            jitterA,
            org.assertj.core.data.Offset
                .offset(1e-12),
        )
        assertThat(connections.getValue("b").backoffIntegralMs).isCloseTo(
            jitterB,
            org.assertj.core.data.Offset
                .offset(1e-12),
        )
    }

    private fun graph(
        steps: List<ServiceStep> =
            listOf(ServiceStep.Process, ServiceStep.Call("a"), ServiceStep.Process, ServiceStep.Call("b"), ServiceStep.Process),
    ): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                listOf(
                    ServiceNode("entry", 1, 2, TestChains.fixed(2.0), 0.0, scenario = steps),
                    ServiceNode("left", 1, 2, TestChains.fixed(5.0), 0.0),
                    ServiceNode("right", 1, 2, TestChains.fixed(11.0), 0.0),
                ),
            calls =
                listOf(
                    CallEdge("a", "entry", "left", TestChains.fixed(3.0), 100.0, 1, TestChains.noBackoff),
                    CallEdge("b", "entry", "right", TestChains.fixed(7.0), 100.0, 1, TestChains.noBackoff),
                ),
            run = base.run.copy(measurementMs = 100.0),
        )
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double> = listOf(0.0),
        selectTarget: (CallEdge, Int) -> String = { edge, _ -> edge.to },
    ): Rig {
        val model = Model("GraphScenarioTest", autoCSVReports = false)
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(model, graph, streams, selectTarget = selectTarget)
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(model, name = "scenario-driver") {
            override fun initialize() {
                arrivals.forEach { invocations += reliability.invoke(graph.entry, it, originalRequest = true) }
            }
        }
        model.numberOfReplications = 1
        model.lengthOfReplication = 200.0
        model.simulate()
        return Rig(reliability, invocations)
    }

    private data class Rig(
        val reliability: ReliabilityModel,
        val invocations: List<ReliabilityModel.ServiceInvocation>,
    )
}
