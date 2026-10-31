package resiliencelab.core.ir

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledPoint
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.compiler.ModelLinter
import resiliencelab.core.engine.ksl.TestChains
import resiliencelab.core.execution.CostEstimator
import kotlin.test.Test

class GraphIrTest {
    private val fixed = Distribution(DistributionShape.FIXED, 1.0)
    private val chain =
        GraphIr(
            client = ClientNode("client", arrivalRatePerMs = 0.1, deadlineMs = 100.0),
            entry = "a",
            services = listOf(ServiceNode("a", 1, 0, fixed, 0.0), ServiceNode("b", 1, 0, fixed, 0.0)),
            calls =
                listOf(
                    CallEdge(
                        path = "a-to-b",
                        from = "a",
                        to = "b",
                        network = fixed,
                        timeoutMs = 10.0,
                        attempts = 1,
                        backoff = Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0),
                        origin = Origin("m.model.json", "/connections/1"),
                    ),
                ),
            faults = emptyList(),
            run = RunSettings(replications = 1, warmupMs = 0.0, measurementMs = 100.0, seed = 1, maxRealTimeSeconds = 30),
        )

    @Test
    fun `finds the outgoing call of a service`() {
        assertThat(chain.outgoingCalls("a").map { it.path }).containsExactly("a-to-b")
        assertThat(chain.outgoingCalls("b")).isEmpty()
    }

    @Test
    fun `keeps the origin of compiled elements and marks elements built in code`() {
        assertThat(chain.calls.single().origin).isEqualTo(Origin("m.model.json", "/connections/1"))
        assertThat(chain.services.first().origin).isEqualTo(Origin.UNSPECIFIED)
    }

    private fun diamond(): GraphIr {
        val root =
            ServiceNode(
                "z-entry",
                10,
                10,
                fixed,
                0.0,
                scenario = listOf(ServiceStep.Process(), ServiceStep.Call("ab"), ServiceStep.Call("ac"), ServiceStep.Call("ab")),
            )
        val b = ServiceNode(listOf("a", "#2"), 10, 10, fixed, 0.0)
        val c = ServiceNode("a-other", 10, 10, fixed, 0.0)
        val d = ServiceNode("0-shared", 10, 10, fixed, 0.0)

        fun edge(
            id: String,
            from: String,
            to: String,
            attempts: Int,
        ) = CallEdge(id, from, to, fixed, 10.0, attempts, TestChains.noBackoff)
        return GraphIr(
            ClientNode("client", 0.01, 1_000.0),
            root.path,
            listOf(d, c, root, b),
            listOf(
                edge("cd", c.path, d.path, 2),
                edge("ac", root.path, c.path, 3),
                edge("bd", b.path, d.path, 1),
                edge("ab", root.path, b.path, 2),
            ),
            emptyList(),
            TestChains.run(replications = 5),
        )
    }

    private fun experiment(graph: GraphIr) =
        CompiledExperiment(
            listOf(CompiledVariant("baseline", "Baseline", listOf(CompiledPoint("p0", emptyMap(), graph)))),
            graph.run,
        )

    @Test
    fun `graph orders branches by path segments and places a shared target last`() {
        val graph = diamond()
        assertThat(graph.topologicalServices.map { it.path }).containsExactly("z-entry", "a#2", "a-other", "0-shared")
        assertThat(graph.topologicalCalls.map { it.path }).containsExactly("ab", "ac", "bd", "cd")
        assertThat(graph.copy(services = graph.services.reversed(), calls = graph.calls.reversed()).topologicalServices)
            .isEqualTo(graph.topologicalServices)
        assertThat(graph.callPaths().map { it.map { edge -> edge.path } }.toList())
            .containsExactly(listOf("ab", "bd"), listOf("ac", "cd"), listOf("ab", "bd"))
    }

    @Test
    fun `estimate sums scenario visits including repeated calls and joined paths`() {
        val graph = diamond().copy(run = TestChains.run(replications = 1))
        // 10 arrivals * 124 events on the scenario plus 100 window boundaries and 3 fixed events.
        assertThat(CostEstimator.estimate(experiment(graph), workers = 1).expectedEvents).isEqualTo(1_343.0)
    }

    @Test
    fun `retry warnings multiply attempts along each path independently`() {
        val warnings =
            ModelLinter(retryAmplificationThreshold = 4)
                .lint(experiment(diamond()))
                .filter { it.code == "LINT_RETRY_AMPLIFICATION" }
        assertThat(warnings).hasSize(1)
        assertThat(warnings.single().path).isEqualTo("ac")
        assertThat(warnings.single().message).contains("up to 6 attempts per request")
    }
}
