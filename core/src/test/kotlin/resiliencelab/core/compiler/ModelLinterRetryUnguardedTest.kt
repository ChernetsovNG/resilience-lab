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
import resiliencelab.core.ir.CircuitBreakerConfig
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FallbackConfig
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.OutlierDetectionConfig
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep

class ModelLinterRetryUnguardedTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val fixed = Distribution(DistributionShape.FIXED, 1.0)
    private val graph =
        GraphIr(
            ClientNode("client", 0.001, 10_000.0),
            "gateway",
            listOf("gateway", "worker").map { ServiceNode(it, 10, 10, fixed, 0.0) },
            listOf(
                CallEdge(
                    "call",
                    "gateway",
                    "worker",
                    fixed,
                    100.0,
                    2,
                    Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 1.0, 10.0, 2.0),
                    Origin("m.model.json", "/connections/1"),
                ),
            ),
            emptyList(),
            run,
        )

    @Test
    fun `two unguarded attempts warn without blocking a run and select attempts`() {
        val diagnostics = warnings(graph)
        assertThat(diagnostics).hasSize(1)
        val warning = diagnostics.single()

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.path).isEqualTo("call")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/1/params/attempts")
        assertThat(warning.args)
            .containsEntry("connection", JsonPrimitive("call"))
            .containsEntry("attempts", JsonPrimitive(2))
            .containsEntry("amplification", JsonPrimitive(2))
        assertThat(warning.message).contains("2", "retryBudget", "circuitBreaker").doesNotContain("2.0")
    }

    @Test
    fun `threshold includes equality and must allow at least one retry`() {
        assertThat(warnings(graph, ModelLinter(retryUnguardedThreshold = 3))).isEmpty()
        assertThat(warnings(graph.copy(calls = graph.calls.map { it.copy(attempts = 3) }), ModelLinter(retryUnguardedThreshold = 3)))
            .hasSize(1)
        assertThat(warnings(graph.copy(calls = graph.calls.map { it.copy(attempts = 1) }))).isEmpty()
        listOf(Int.MIN_VALUE, -1, 0, 1).forEach { threshold ->
            assertThatThrownBy { ModelLinter(retryUnguardedThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `either retry budget or circuit breaker suppresses the warning`() {
        val call = graph.calls.single()
        val budget = RetryBudgetConfig(0.5, 0.1, 1_000.0)
        val breaker = CircuitBreakerConfig(0.5, 10, 20, 1_000.0, 1)

        listOf(
            call.copy(retryBudget = budget),
            call.copy(circuitBreaker = breaker),
            call.copy(retryBudget = budget, circuitBreaker = breaker),
        ).forEach { guarded ->
            assertThat(warnings(graph.copy(calls = listOf(guarded)))).isEmpty()
        }
    }

    @Test
    fun `jitter other targets fallback and outlier detection do not replace a retry guard`() {
        val changed =
            graph.copy(
                calls =
                    graph.calls.map {
                        it.copy(
                            retryTarget = RetryTarget.OTHER,
                            fallback = FallbackConfig(setOf("timeout"), 1.0),
                            outlierDetection = OutlierDetectionConfig(2, 1_000.0, 0.5),
                        )
                    },
            )

        assertThat(warnings(changed)).hasSize(1)
    }

    @Test
    fun `two clients and two request types warn once per applicable call and skip unused steps`() {
        val changed =
            graph.copy(
                clients =
                    listOf("first", "second").map { name ->
                        graph.client.copy(
                            pathSegments = listOf(name),
                            classes = mapOf("read" to LoadProfile.constant(0.001), "write" to LoadProfile.constant(0.001)),
                        )
                    },
                calls = listOf("read", "write", "unused").map { name -> graph.calls.single().copy(pathSegments = listOf(name)) },
                services =
                    graph.services.map {
                        if (it.path == "gateway") {
                            it.copy(
                                scenario =
                                    listOf(
                                        ServiceStep.Process(),
                                        ServiceStep.Call("read", classes = setOf("read")),
                                        ServiceStep.Call("write", classes = setOf("write")),
                                        ServiceStep.Call("unused", classes = setOf("other")),
                                    ),
                            )
                        } else {
                            it
                        }
                    },
            )

        assertThat(warnings(changed).map { it.path }).containsExactlyInAnyOrder("read", "write")
        assertThat(
            warnings(
                changed.copy(
                    calls =
                        changed.calls
                            .map {
                                it.copy(pathSegments = listOf("shared"))
                            }.take(1),
                    services = graph.services,
                ),
            ),
        ).hasSize(1)
    }

    @Test
    fun `replicated callers retain instance context with replica overrides`() {
        val fixtures = ReplicaGroupsTest()
        val model =
            attempts(
                fixtures.model(2, overrides = """, "replicaOverrides":{"2":{"processing":{"kind":"fixed","mean":"20ms"}}}"""),
                "worker-to-tail",
            )
        val diagnostics = compiledWarnings(fixtures.compile(model))

        assertThat(diagnostics.map { it.path }).containsExactlyInAnyOrder("worker-to-tail#1", "worker-to-tail#2")
        assertThat(diagnostics).allSatisfy { warning ->
            assertThat(warning.pointer).isEqualTo("/connections/2/params/attempts")
            assertThat(warning.args).containsEntry("service", JsonPrimitive("worker"))
        }
        assertThat(diagnostics).anySatisfy { warning ->
            assertThat(warning.message).contains("worker#2")
            assertThat(warning.args).containsEntry("replica", JsonPrimitive(2))
        }
    }

    @Test
    fun `variants select the attempts override and a budget override suppresses its variant`() {
        val fixtures = ReplicaGroupsTest()
        val changed =
            fixtures.experiment().copy(
                variants =
                    listOf(
                        Variant("base"),
                        Variant("retry", overrides = mapOf("gateway-to-worker.attempts" to JsonPrimitive(2))),
                        Variant(
                            "guarded",
                            overrides =
                                mapOf(
                                    "gateway-to-worker.attempts" to JsonPrimitive(2),
                                    "gateway-to-worker.retryBudget" to
                                        JsonObject(
                                            mapOf(
                                                "ratio" to JsonPrimitive("20%"),
                                                "minPerSecond" to JsonPrimitive("0/s"),
                                                "window" to JsonPrimitive("1s"),
                                            ),
                                        ),
                                ),
                        ),
                    ),
            )

        assertThat(compiledWarnings(fixtures.compile(fixtures.model(2), changed))).hasSize(1).allSatisfy { warning ->
            assertThat(warning.variant).isEqualTo("retry")
            assertThat(warning.document).isEqualTo("e.experiment.json")
            assertThat(warning.pointer).isEqualTo("/variants/1/overrides/gateway-to-worker.attempts")
        }
    }

    @Test
    fun `grid findings name only affected points and select each attempts value`() {
        val fixtures = ReplicaGroupsTest()
        val changed =
            fixtures.experiment().copy(
                grid = listOf(GridAxis("worker-to-tail.attempts", listOf(JsonPrimitive(1), JsonPrimitive(2)))),
            )

        assertThat(compiledWarnings(fixtures.compile(fixtures.model(2), changed))).hasSize(2).allSatisfy { warning ->
            assertThat(warning.variant).isEqualTo("baseline")
            assertThat(warning.document).isEqualTo("e.experiment.json")
            assertThat(warning.pointer).isEqualTo("/grid/0/values/1")
            assertThat(warning.args).containsEntry("points", JsonPrimitive("p1"))
        }
    }

    @Test
    fun `equivalent variants share one model finding`() {
        val fixtures = ReplicaGroupsTest()
        val changed = fixtures.experiment().copy(variants = listOf(Variant("base"), Variant("same")))

        assertThat(compiledWarnings(fixtures.compile(attempts(fixtures.model(1), "gateway-to-worker"), changed)))
            .hasSize(1)
            .allSatisfy { warning ->
                assertThat(warning.variant).isNull()
                assertThat(warning.document).isEqualTo("m.model.json")
            }
    }

    @Test
    fun `local missing guards and path amplification detect independent risks`() {
        assertThat(diagnostics(graph).map { it.code }).contains("LINT_RETRY_UNGUARDED").doesNotContain("LINT_RETRY_AMPLIFICATION")

        val guarded = graph.calls.single().copy(attempts = 4, retryBudget = RetryBudgetConfig(0.5, 0.0, 1_000.0))
        val chain =
            graph.copy(
                services = graph.services + ServiceNode("tail", 10, 10, fixed, 0.0),
                calls = listOf(guarded, guarded.copy(pathSegments = listOf("downstream"), from = "worker", to = "tail")),
            )

        assertThat(diagnostics(chain).map { it.code }).contains("LINT_RETRY_AMPLIFICATION").doesNotContain("LINT_RETRY_UNGUARDED")
        assertThat(diagnostics(chain).single { it.code == "LINT_RETRY_AMPLIFICATION" }.args)
            .containsEntry("amplification", JsonPrimitive(16))
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
        return ModelLinter().lint(requireNotNull(result.experiment)).filter { it.code == "LINT_RETRY_UNGUARDED" }
    }

    private fun diagnostics(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> =
        linter
            .lint(CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run))

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> = diagnostics(graph, linter).filter { it.code == "LINT_RETRY_UNGUARDED" }
}
