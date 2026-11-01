package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import resiliencelab.core.document.GridAxis
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Variant
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep

class ModelLinterRetrySameTargetTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val fixed = Distribution(DistributionShape.FIXED, 1.0)
    private val graph =
        GraphIr(
            ClientNode("client", 0.001, 10_000.0),
            "gateway",
            listOf("gateway", "a", "b").map { ServiceNode(it, 10, 10, fixed, 0.0) },
            listOf(
                CallEdge(
                    "call",
                    "gateway",
                    "router",
                    fixed,
                    100.0,
                    2,
                    Backoff(BackoffKind.NONE, 0.0, 0.0, 1.0),
                    Origin("m.model.json", "/connections/1"),
                ),
            ),
            emptyList(),
            run,
            listOf(RouterNode("router", RoutingPolicy.RANDOM)),
            listOf(RouteEdge("route-a", "router", "a"), RouteEdge("route-b", "router", "b")),
        )

    @Test
    fun `two attempts to two targets warn at the default threshold`() {
        val warning = warnings(graph).single()

        assertThat(warning.severity.name).isEqualTo("ADVICE")
        assertThat(warning.path).isEqualTo("call")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/1/params/attempts")
        assertThat(warning.args)
            .containsEntry("attempts", JsonPrimitive(2))
            .containsEntry("targets", JsonPrimitive(2))
            .containsEntry("requestType", JsonPrimitive("default"))
        assertThat(warning.message).contains("2", "retryTarget: other")
    }

    @Test
    fun `attempt threshold includes equality and must allow at least one retry`() {
        assertThat(warnings(graph, ModelLinter(retrySameTargetThreshold = 3))).isEmpty()
        assertThat(warnings(graph.copy(calls = graph.calls.map { it.copy(attempts = 3) }), ModelLinter(retrySameTargetThreshold = 3)))
            .hasSize(1)
        listOf(Int.MIN_VALUE, -1, 0, 1).forEach { threshold ->
            assertThatThrownBy { ModelLinter(retrySameTargetThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `single attempts other targets and singleton targets remain silent`() {
        assertThat(warnings(graph.copy(calls = graph.calls.map { it.copy(attempts = 1) }))).isEmpty()
        assertThat(warnings(graph.copy(calls = graph.calls.map { it.copy(retryTarget = RetryTarget.OTHER) }))).isEmpty()
        assertThat(warnings(graph.copy(routes = graph.routes.take(1)))).isEmpty()
        assertThat(warnings(graph.copy(calls = graph.calls.map { it.copy(to = "a") }, routers = emptyList(), routes = emptyList())))
            .isEmpty()
    }

    @Test
    fun `two clients share a finding and request types retain their eligible targets`() {
        val changed =
            graph.copy(
                clients =
                    listOf("first", "second").map { name ->
                        graph.client.copy(
                            pathSegments = listOf(name),
                            classes = mapOf("read" to LoadProfile.constant(0.001), "write" to LoadProfile.constant(0.001)),
                        )
                    },
                routes =
                    listOf(
                        RouteEdge("read-a", "router", "a", classes = setOf("read")),
                        RouteEdge("read-b", "router", "b", classes = setOf("read")),
                        RouteEdge("write-a", "router", "a", classes = setOf("write")),
                    ),
            )

        assertThat(warnings(changed)).hasSize(1).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("requestType", JsonPrimitive("read")).containsEntry("targets", JsonPrimitive(2))
        }
        assertThat(warnings(changed.copy(routes = changed.routes.filter { it.path != "read-b" }))).isEmpty()
        assertThat(
            warnings(
                changed.copy(
                    services =
                        changed.services.map {
                            if (it.path == "gateway") {
                                it.copy(scenario = listOf(ServiceStep.Process(), ServiceStep.Call("call", classes = setOf("write"))))
                            } else {
                                it
                            }
                        },
                ),
            ),
        ).isEmpty()
    }

    @Test
    fun `routing policies and retry budgets do not guarantee avoiding the previous target`() {
        RoutingPolicy.entries.forEach { policy ->
            val changed =
                graph.copy(
                    routers = graph.routers.map { it.copy(policy = policy) },
                    calls = graph.calls.map { it.copy(retryBudget = RetryBudgetConfig(0.0, 0.0, 1_000.0)) },
                )
            assertThat(warnings(changed)).describedAs(policy.name).hasSize(1)
        }
    }

    @Test
    fun `explicit any points to retryTarget while default any points to attempts`() {
        val fixtures = ReplicaGroupsTest()
        val model = attempts(fixtures.model(2), "gateway-to-worker")
        val defaultWarning = compiledWarnings(fixtures.compile(model)).single()
        assertThat(defaultWarning.pointer).isEqualTo("/connections/1/params/attempts")

        val explicit =
            model.copy(
                connections =
                    model.connections.map {
                        if (it.id ==
                            "gateway-to-worker"
                        ) {
                            it.copy(params = JsonObject(it.params + ("retryTarget" to JsonPrimitive("any"))))
                        } else {
                            it
                        }
                    },
            )
        assertThat(compiledWarnings(fixtures.compile(explicit))).hasSize(1).allSatisfy { warning ->
            assertThat(warning.pointer).isEqualTo("/connections/1/params/retryTarget")
        }
    }

    @Test
    fun `replicated callers retain instance context including replica overrides`() {
        val fixtures = ReplicaGroupsTest()
        val model =
            attempts(
                fixtures.model(
                    2,
                    tailReplicas = 2,
                    overrides = """, "replicaOverrides":{"2":{"processing":{"kind":"fixed","mean":"20ms"}}}""",
                ),
                "worker-to-tail",
            )
        val diagnostics = compiledWarnings(fixtures.compile(model))

        assertThat(diagnostics).hasSize(2).allSatisfy { warning ->
            assertThat(warning.pointer).isEqualTo("/connections/2/params/attempts")
            assertThat(warning.args).containsEntry("targets", JsonPrimitive(2)).containsEntry("service", JsonPrimitive("worker"))
        }
        assertThat(diagnostics).anySatisfy { warning ->
            assertThat(warning.message).contains("worker#2")
            assertThat(warning.args).containsEntry("replica", JsonPrimitive(2))
        }
    }

    @Test
    fun `variants and grid retain explicit retryTarget and default attempts override origins`() {
        val fixtures = ReplicaGroupsTest()
        val model = attempts(fixtures.model(2), "gateway-to-worker")
        val varied =
            fixtures.experiment().copy(
                variants =
                    listOf(
                        Variant("base"),
                        Variant("explicit", overrides = mapOf("gateway-to-worker.retryTarget" to JsonPrimitive("any"))),
                        Variant("more", overrides = mapOf("gateway-to-worker.attempts" to JsonPrimitive(3))),
                    ),
            )
        val warnings = compiledWarnings(fixtures.compile(model, varied))
        assertThat(warnings).hasSize(3)
        assertThat(warnings).anySatisfy { warning ->
            assertThat(warning.variant).isEqualTo("explicit")
            assertThat(warning.document).isEqualTo("e.experiment.json")
            assertThat(warning.pointer).isEqualTo("/variants/1/overrides/gateway-to-worker.retryTarget")
        }
        assertThat(warnings).anySatisfy { warning ->
            assertThat(warning.variant).isEqualTo("more")
            assertThat(warning.pointer).isEqualTo("/variants/2/overrides/gateway-to-worker.attempts")
        }
        listOf(
            GridAxis("gateway-to-worker.retryTarget", listOf(JsonPrimitive("other"), JsonPrimitive("any"))),
            GridAxis("gateway-to-worker.attempts", listOf(JsonPrimitive(1), JsonPrimitive(2))),
        ).forEach { axis ->
            val grid = fixtures.experiment().copy(grid = listOf(axis))
            assertThat(compiledWarnings(fixtures.compile(model, grid))).hasSize(1).allSatisfy { warning ->
                assertThat(warning.document).isEqualTo("e.experiment.json")
                assertThat(warning.pointer).isEqualTo("/grid/0/values/1")
                assertThat(warning.variant).isEqualTo("baseline")
                assertThat(warning.args).containsEntry("points", JsonPrimitive("p1"))
            }
        }
    }

    private fun attempts(
        model: ModelFile,
        call: String,
    ) = model.copy(
        connections =
            model.connections.map {
                if (it.id == call) it.copy(params = JsonObject(it.params + ("attempts" to JsonPrimitive(2)))) else it
            },
    )

    private fun compiledWarnings(result: CompileResult): List<Diagnostic> {
        assertThat(result.diagnostics).isEmpty()
        return ModelLinter().lint(requireNotNull(result.experiment)).filter { it.code == "LINT_RETRY_SAME_TARGET" }
    }

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> =
        linter
            .lint(CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run))
            .filter { it.code == "LINT_RETRY_SAME_TARGET" }
}
