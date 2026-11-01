package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.document.GridAxis
import resiliencelab.core.document.Variant
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.PoolerSettings
import resiliencelab.core.ir.RateLimitConfig
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class ModelLinterLowHeadroomTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val graph = GraphIr(ClientNode("client", 0.16, 1_000.0), "b", listOf(service("b", 20.0)), emptyList(), emptyList(), run)

    @Test
    fun `threshold equality warns with nominal load inputs and handlers origin`() {
        val warning = warnings(graph).single()

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.path).isEqualTo("b")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/blocks/b/params/handlers")
        assertThat(warning.args).containsAllEntriesOf(
            mapOf(
                "target" to JsonPrimitive("b"),
                "ratePerSecond" to JsonPrimitive("160"),
                "offeredRatePerSecond" to JsonPrimitive("160"),
                "utilization" to JsonPrimitive("0.8"),
                "holdingMs" to JsonPrimitive("20"),
                "handlers" to JsonPrimitive(4),
                "threshold" to JsonPrimitive("0.8"),
            ),
        )
        assertThat(warning.message).contains("'b'", "160", "0.8", "20", "4")
        assertThat(warnings(withRate(Math.nextDown(0.16)))).isEmpty()
        assertThat(warnings(withRate(0.0))).isEmpty()
        assertThat(warnings(withRate(Math.nextDown(0.2)))).hasSize(1)
    }

    @Test
    fun `capacity equality and overload warn only about insufficient handlers`() {
        listOf(0.2, Math.nextUp(0.2), 0.3).forEach { rate ->
            val diagnostics = ModelLinter().lint(experiment(withRate(rate)))

            assertThat(diagnostics.filter { it.code == "LINT_LOW_HEADROOM" }).describedAs("rate %s", rate).isEmpty()
            assertThat(diagnostics.filter { it.code == "LINT_HANDLERS_LITTLE" }).describedAs("rate %s", rate).hasSize(1)
        }
    }

    @Test
    fun `holding uses all distribution means and downstream networks without retries backoff or failures`() {
        DistributionShape.entries.forEach { shape ->
            BackoffKind.entries.forEach { kind ->
                val changed =
                    graph.copy(
                        clients = listOf(graph.client.copy(entry = "a", classes = mapOf("default" to LoadProfile.constant(0.1)))),
                        services =
                            listOf(
                                service("a", 0.0).copy(handlers = 1_000),
                                service("b", 10.0).copy(processing = Distribution(shape, 10.0, 1.0)),
                                service(
                                    "c",
                                    20.0,
                                ).copy(handlers = 1_000, processing = Distribution(shape, 20.0, 1.0), failureProbability = 1.0),
                            ),
                        calls =
                            listOf(
                                call("a-b", "a", "b").copy(network = fixed(200.0)),
                                call("b-c", "b", "c").copy(
                                    network = Distribution(shape, 1.0, 1.0),
                                    attempts = 10,
                                    backoff = Backoff(kind, 900.0, 1_000.0, 2.0),
                                    retryBudget = RetryBudgetConfig(0.0, 0.0, 1_000.0),
                                ),
                            ),
                    )

                assertThat(warnings(changed).single().args)
                    .containsEntry("holdingMs", JsonPrimitive("32"))
                    .containsEntry("utilization", JsonPrimitive("0.8"))
            }
        }
    }

    @Test
    fun `profile maximum covers the arrival interval and ignores later peaks`() {
        val profile =
            LoadProfile(listOf(LoadPoint(0.0, 0.01), LoadPoint(500.0, 0.16), LoadPoint(1_000.0, 0.16), LoadPoint(2_000.0, 0.4)))
        val changed = graph.copy(clients = listOf(graph.client.copy(classes = mapOf("default" to profile))))

        assertThat(warnings(changed).single().args).containsEntry("ratePerSecond", JsonPrimitive("160"))
    }

    @Test
    fun `clients and request types add demand using only their processing steps`() {
        val changed =
            graph.copy(
                clients =
                    listOf("first", "second").map { name ->
                        graph.client.copy(
                            pathSegments = listOf(name),
                            classes = mapOf("read" to LoadProfile.constant(0.02), "write" to LoadProfile.constant(0.03)),
                        )
                    },
                services =
                    listOf(
                        graph.services.single().copy(
                            scenario = listOf(ServiceStep.Process(), ServiceStep.Process(fixed(20.0), classes = setOf("write"))),
                        ),
                    ),
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("100"))
            .containsEntry("holdingMs", JsonPrimitive("32"))
            .containsEntry("utilization", JsonPrimitive("0.8"))
    }

    @Test
    fun `router thirds preserve both utilization boundaries without rounding nearby rates`() {
        fun routed(rate: Double) =
            graph.copy(
                clients = listOf(graph.client.copy(entry = "router", classes = mapOf("default" to LoadProfile.constant(rate)))),
                services = listOf("b", "c", "d").map { service(it, 12.0).copy(handlers = 2) },
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf("b", "c", "d").map { RouteEdge(it, "router", it) },
            )

        assertThat(warnings(routed(0.4))).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("utilization", JsonPrimitive("0.8"))
        }
        assertThat(warnings(routed(Math.nextDown(0.4)))).isEmpty()
        assertThat(warnings(routed(0.5))).isEmpty()
        assertThat(ModelLinter().lint(experiment(routed(0.5))).filter { it.code == "LINT_HANDLERS_LITTLE" }).hasSize(3)
    }

    @Test
    fun `random router weights respect request type filters`() {
        val changed =
            graph.copy(
                clients = listOf(graph.client.copy(entry = "router", classes = mapOf("read" to LoadProfile.constant(0.64)))),
                services = graph.services + service("c", 0.0),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes =
                    listOf(
                        RouteEdge("b", "router", "b", 1.0, classes = setOf("read")),
                        RouteEdge("c", "router", "c", 3.0, classes = setOf("read")),
                        RouteEdge("write", "router", "b", 100.0, classes = setOf("write")),
                    ),
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("target", JsonPrimitive("b"))
            .containsEntry("ratePerSecond", JsonPrimitive("160"))
    }

    @Test
    fun `rate limit caps nominal utilization and reports the configured limit`() {
        val changed = withRate(0.3).copy(services = listOf(graph.services.single().copy(rateLimit = RateLimitConfig(0.16, 1))))
        val warning = warnings(changed).single()

        assertThat(warning.args)
            .containsEntry("ratePerSecond", JsonPrimitive("160"))
            .containsEntry("offeredRatePerSecond", JsonPrimitive("300"))
            .containsEntry("rateLimitPerSecond", JsonPrimitive("160"))
            .containsEntry("reason", JsonPrimitive("rateLimit"))
            .containsEntry("utilization", JsonPrimitive("0.8"))
        assertThat(warning.message).contains("rate limit", "160")
        assertThat(
            warnings(changed.copy(services = listOf(changed.services.single().copy(rateLimit = RateLimitConfig(0.15, 100))))),
        ).isEmpty()
    }

    @Test
    fun `database points to maxConnections and pooler is excluded`() {
        val database = graph.copy(services = listOf(graph.services.single().copy(type = "database")))
        assertThat(warnings(database).single().pointer).isEqualTo("/blocks/b/params/maxConnections")
        val pooler = graph.copy(services = listOf(graph.services.single().copy(type = "pooler", pooler = PoolerSettings(4, 1_000.0))))
        assertThat(warnings(pooler)).isEmpty()
    }

    @Test
    fun `replica override uses that instances load capacity and origin`() {
        val fixtures = ReplicaGroupsTest()
        val model = fixtures.model(2, overrides = """, "replicaOverrides":{"2":{"handlers":1,"processing":{"mean":"78.5ms"}}}""")
        val compiled = fixtures.compile(model)
        assertThat(compiled.diagnostics).isEmpty()
        val warning =
            ModelLinter().lint(requireNotNull(compiled.experiment)).single {
                it.code == "LINT_LOW_HEADROOM" &&
                    it.path?.startsWith("worker") == true
            }

        assertThat(warning.path).isEqualTo("worker#2")
        assertThat(warning.pointer).isEqualTo("/blocks/worker/replicaOverrides/2/handlers")
        assertThat(warning.message).contains("worker#2")
        assertThat(warning.args)
            .containsEntry("replica", JsonPrimitive(2))
            .containsEntry("utilization", JsonPrimitive("0.8"))
    }

    @Test
    fun `variant and grid handlers retain their origins and affected points`() {
        val fixtures = ReplicaGroupsTest()
        val model = fixtures.model(1, overrides = """, "replicaOverrides":{"1":{"processing":{"mean":"78.5ms"}}}""")
        val varied =
            fixtures.experiment().copy(
                variants =
                    listOf(
                        Variant("roomy", overrides = mapOf("worker.handlers" to JsonPrimitive(4))),
                        Variant("tight", overrides = mapOf("worker.handlers" to JsonPrimitive(2))),
                    ),
            )
        val compiled = fixtures.compile(model, varied)
        assertThat(compiled.diagnostics).isEmpty()
        val warning =
            ModelLinter().lint(requireNotNull(compiled.experiment)).single {
                it.code == "LINT_LOW_HEADROOM" &&
                    it.path?.startsWith("worker") == true
            }
        assertThat(warning.variant).isEqualTo("tight")
        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/1/overrides/worker.handlers")

        val grid = fixtures.experiment().copy(grid = listOf(GridAxis("worker.handlers", listOf(JsonPrimitive(2), JsonPrimitive(4)))))
        val swept = fixtures.compile(model, grid)
        assertThat(swept.diagnostics).isEmpty()
        val gridWarning =
            ModelLinter().lint(requireNotNull(swept.experiment)).single {
                it.code == "LINT_LOW_HEADROOM" &&
                    it.path?.startsWith("worker") == true
            }
        assertThat(gridWarning.variant).isEqualTo("baseline")
        assertThat(gridWarning.pointer).isEqualTo("/grid/0/values/0")
        assertThat(gridWarning.args).containsEntry("points", JsonPrimitive("p0"))
    }

    @Test
    fun `identical model findings group across variants and all grid points`() {
        val variants =
            listOf("one", "two").map {
                CompiledVariant(it, it, listOf(CompiledPoint("p0", emptyMap(), graph), CompiledPoint("p1", emptyMap(), graph)))
            }
        val warning = ModelLinter().lint(CompiledExperiment(variants, run)).single { it.code == "LINT_LOW_HEADROOM" }

        assertThat(warning.variant).isNull()
        assertThat(warning.args).doesNotContainKey("points")
    }

    @Test
    fun `headroom threshold is configurable with inclusive equality`() {
        assertThat(warnings(graph, ModelLinter(lowHeadroomThreshold = 0.81))).isEmpty()
        assertThat(warnings(graph, ModelLinter(lowHeadroomThreshold = 0.8))).hasSize(1)
        val warning = warnings(withRate(0.08), ModelLinter(lowHeadroomThreshold = 0.4)).single()
        assertThat(warning.args).containsEntry("threshold", JsonPrimitive("0.4"))
    }

    @Test
    fun `headroom threshold rejects nonfinite values and both ends of the unit interval`() {
        listOf(0.0, -1.0, 1.0, 1.01, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).forEach { threshold ->
            assertThatThrownBy { ModelLinter(lowHeadroomThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    private fun experiment(graph: GraphIr) =
        CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run)

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> =
        linter.lint(experiment(graph)).filter {
            it.code ==
                "LINT_LOW_HEADROOM"
        }

    private fun withRate(rate: Double) =
        graph.copy(
            clients =
                listOf(
                    graph.client.copy(
                        classes =
                            mapOf(
                                "default" to LoadProfile.constant(rate),
                            ),
                    ),
                ),
        )

    private fun fixed(meanMs: Double) = Distribution(DistributionShape.FIXED, meanMs)

    private fun service(
        path: String,
        meanMs: Double,
    ) = ServiceNode(path, 4, 0, fixed(meanMs), 0.0, Origin("m.model.json", "/blocks/$path"))

    private fun call(
        path: String,
        from: String,
        to: String,
    ) = CallEdge(
        path,
        from,
        to,
        fixed(0.0),
        1_000.0,
        1,
        Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0),
        Origin("m.model.json", "/connections/$path"),
    )
}
