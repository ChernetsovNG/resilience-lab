package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.assertj.core.api.Assertions.within
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

class ModelLinterRejectionRiskTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val graph =
        GraphIr(
            ClientNode("client", 0.05, 1_000.0),
            "b",
            listOf(service()),
            emptyList(),
            emptyList(),
            run,
        )

    @Test
    fun `queue free service warns below full utilization with Erlang B probability and queue origin`() {
        val warning = ModelLinter().lint(experiment(graph)).single { it.code == "LINT_REJECTION_RISK" }

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.path).isEqualTo("b")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/blocks/b/params/queue")
        assertThat(warning.args).containsEntry("ratePerSecond", JsonPrimitive("50")).containsEntry("holdingMs", JsonPrimitive("100"))
        assertThat(warning.args).containsEntry("handlers", JsonPrimitive(10)).containsEntry("thresholdPercent", JsonPrimitive("1"))
        assertThat(
            warning.args!!
                .getValue("rejectionPercent")
                .jsonPrimitive.content
                .toDouble(),
        ).isCloseTo(1.83845703366, within(1e-10))
        assertThat(warning.message).contains("'b'", "%", "50", "100", "10")
    }

    @Test
    fun `probabilities match the rounded ITU Erlang B traffic table`() {
        // ITU-T E.800 Series Supplement 1 (1988), n = 10; loads rounded to two decimals.
        // https://www.itu.int/rec/T-REC-E.800SerSup1-198811-I/en
        listOf(5.53 to 3.0, 6.22 to 5.0, 6.78 to 7.0).forEach { (load, percent) ->
            val warning = warnings(withRate(load / 100.0)).single()
            assertThat(
                warning.args!!
                    .getValue("rejectionPercent")
                    .jsonPrimitive.content
                    .toDouble(),
            ).describedAs("10 slots, %s erlangs", load)
                .isCloseTo(percent, within(0.02))
        }
        assertThat(warnings(withRate(0.04))).isEmpty()
    }

    @Test
    fun `configurable probability threshold includes equality without rounding nearby rates`() {
        val single = graph.copy(services = listOf(service(handlers = 1, meanMs = 20.0)))
        val warning = warnings(single, ModelLinter(rejectionRiskThreshold = 0.5)).single()
        assertThat(warning.args)
            .containsEntry("rejectionPercent", JsonPrimitive("50"))
            .containsEntry("thresholdPercent", JsonPrimitive("50"))
            .containsEntry("offeredLoad", JsonPrimitive("1"))
        assertThat(warnings(single, ModelLinter(rejectionRiskThreshold = Math.nextUp(0.5)))).isEmpty()
        assertThat(warnings(withRate(Math.nextDown(0.05), single), ModelLinter(rejectionRiskThreshold = 0.5))).isEmpty()
        assertThat(warnings(withRate(Math.nextUp(0.05), single), ModelLinter(rejectionRiskThreshold = 0.5))).hasSize(1)
        assertThat(warnings(single, ModelLinter(rejectionRiskThreshold = 1.0))).isEmpty()
    }

    @Test
    fun `threshold rejects nonfinite probabilities and values outside zero exclusive to one inclusive`() {
        listOf(0.0, -1.0, 1.01, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).forEach { threshold ->
            assertThatThrownBy { ModelLinter(rejectionRiskThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `recurring router shares preserve exact equality at the default probability threshold`() {
        val routed =
            graph.copy(
                clients = listOf(graph.client.copy(entry = "router", classes = mapOf("default" to LoadProfile.constant(0.001)))),
                services = listOf(service(handlers = 1, meanMs = 1_000.0), service("c").copy(queueCapacity = 1)),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes = listOf(RouteEdge("b", "router", "b", 1.0), RouteEdge("c", "router", "c", 98.0)),
            )
        // A = 1/99 erlang, B(1, A) = A / (1 + A) = 1/100 exactly.
        assertThat(warnings(routed).single().args).containsEntry("rejectionPercent", JsonPrimitive("1"))
        val below = routed.copy(routes = listOf(routed.routes.first(), routed.routes.last().copy(weight = Math.nextUp(98.0))))
        assertThat(warnings(below)).isEmpty()
        assertThat(warnings(withRate(1e100), ModelLinter(rejectionRiskThreshold = 1.0))).isEmpty()
    }

    @Test
    fun `queue capacity zero arrivals and zero holding suppress the warning`() {
        assertThat(warnings(graph.copy(services = listOf(service().copy(queueCapacity = 1))))).isEmpty()
        assertThat(warnings(withRate(0.0))).isEmpty()
        assertThat(warnings(graph.copy(services = listOf(service(meanMs = 0.0))))).isEmpty()
    }

    @Test
    fun `recurrence remains finite for large capacity and heavy overload`() {
        val large = withRate(10.0).copy(services = listOf(service(handlers = 1_000)))
        val percent =
            warnings(large)
                .single()
                .args!!
                .getValue("rejectionPercent")
                .jsonPrimitive.content
                .toDouble()
        assertThat(percent).isBetween(2.48, 2.49)
        val overloaded =
            warnings(withRate(1_000_000.0))
                .single()
                .args!!
                .getValue("rejectionPercent")
                .jsonPrimitive.content
                .toDouble()
        assertThat(overloaded).isBetween(99.99, 100.0)
    }

    @Test
    fun `holding uses all distribution means and downstream networks without retries backoff or failures`() {
        DistributionShape.entries.forEach { shape ->
            BackoffKind.entries.forEach { kind ->
                val changed =
                    graph.copy(
                        services =
                            listOf(
                                service(meanMs = 30.0).copy(processing = Distribution(shape, 30.0, 1.0)),
                                service("c", meanMs = 50.0).copy(
                                    processing = Distribution(shape, 50.0, 1.0),
                                    failureProbability = 1.0,
                                    queueCapacity = 1,
                                ),
                            ),
                        calls =
                            listOf(
                                CallEdge(
                                    "b-c",
                                    "b",
                                    "c",
                                    Distribution(shape, 10.0, 1.0),
                                    1.0,
                                    10,
                                    Backoff(kind, 900.0, 1_000.0, 2.0),
                                    Origin("m.model.json", "/connections/b-c"),
                                    retryBudget = RetryBudgetConfig(0.0, 0.0, 1_000.0),
                                ),
                            ),
                    )
                assertThat(warnings(changed).single().args)
                    .containsEntry("holdingMs", JsonPrimitive("100"))
                    .containsEntry("offeredLoad", JsonPrimitive("5"))
            }
        }
    }

    @Test
    fun `profile maximum covers the arrival interval and ignores later peaks`() {
        val profile = LoadProfile(listOf(LoadPoint(0.0, 0.01), LoadPoint(500.0, 0.05), LoadPoint(1_000.0, 0.05), LoadPoint(2_000.0, 0.4)))
        val changed = graph.copy(clients = listOf(graph.client.copy(classes = mapOf("default" to profile))))
        assertThat(warnings(changed).single().args).containsEntry("ratePerSecond", JsonPrimitive("50"))
    }

    @Test
    fun `clients and request types add only their applicable processing demand`() {
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
                        service(meanMs = 20.0).copy(
                            scenario =
                                listOf(
                                    ServiceStep.Process(),
                                    ServiceStep.Process(Distribution(DistributionShape.FIXED, 50.0), classes = setOf("write")),
                                ),
                        ),
                    ),
            )
        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("100"))
            .containsEntry("holdingMs", JsonPrimitive("50"))
            .containsEntry("offeredLoad", JsonPrimitive("5"))
    }

    @Test
    fun `router shares split arrivals before computing each targets probability`() {
        val changed =
            graph.copy(
                clients = listOf(graph.client.copy(entry = "router", classes = mapOf("default" to LoadProfile.constant(0.15)))),
                services = listOf("b", "c", "d").map { service(it) },
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf("b", "c", "d").map { RouteEdge(it, "router", it) },
            )
        assertThat(warnings(changed)).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("ratePerSecond", JsonPrimitive("50")).containsEntry("offeredLoad", JsonPrimitive("5"))
        }
        val weighted =
            changed.copy(
                clients = listOf(graph.client.copy(entry = "router", classes = mapOf("read" to LoadProfile.constant(0.2)))),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes =
                    listOf(
                        RouteEdge("b", "router", "b", 1.0, classes = setOf("read")),
                        RouteEdge("c", "router", "c", 3.0, classes = setOf("read")),
                        RouteEdge("write", "router", "d", 100.0, classes = setOf("write")),
                    ),
            )
        assertThat(warnings(weighted).single { it.path == "b" }.args).containsEntry("ratePerSecond", JsonPrimitive("50"))
        assertThat(warnings(weighted).none { it.path == "d" }).isTrue()
    }

    @Test
    fun `local rate limit caps nominal load before the probability estimate`() {
        val changed = withRate(0.2).copy(services = listOf(service().copy(rateLimit = RateLimitConfig(0.05, 1))))
        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("50"))
            .containsEntry("offeredRatePerSecond", JsonPrimitive("200"))
            .containsEntry("offeredLoad", JsonPrimitive("5"))
        assertThat(warnings(changed.copy(services = listOf(service().copy(rateLimit = RateLimitConfig(0.01, 100)))))).isEmpty()
    }

    @Test
    fun `database uses queue origin and pooler is excluded`() {
        assertThat(warnings(graph.copy(services = listOf(service().copy(type = "database"))))).hasSize(1).allSatisfy {
            assertThat(it.pointer).isEqualTo("/blocks/b/params/queue")
        }
        assertThat(warnings(graph.copy(services = listOf(service().copy(type = "pooler", pooler = PoolerSettings(10, 1_000.0)))))).isEmpty()
    }

    @Test
    fun `replica overrides use individual capacity holding and queue origin`() {
        val fixtures = ReplicaGroupsTest()
        val model = fixtures.model(2, overrides = """, "replicaOverrides":{"2":{"handlers":1,"queue":0,"processing":{"mean":"100ms"}}}""")
        val compiled = fixtures.compile(model)
        assertThat(compiled.diagnostics).isEmpty()
        val warning =
            ModelLinter().lint(requireNotNull(compiled.experiment)).single {
                it.code == "LINT_REJECTION_RISK" &&
                    it.path == "worker#2"
            }
        assertThat(warning.pointer).isEqualTo("/blocks/worker/replicaOverrides/2/queue")
        assertThat(warning.message).contains("worker#2")
        assertThat(warning.args).containsEntry("replica", JsonPrimitive(2)).containsEntry("handlers", JsonPrimitive(1))
    }

    @Test
    fun `variant and grid queue overrides retain their origins and affected points`() {
        val fixtures = ReplicaGroupsTest()
        val model = fixtures.model(1)
        val varied =
            fixtures.experiment().copy(
                variants =
                    listOf("queued", "loss").map { name ->
                        Variant(
                            name,
                            overrides =
                                mapOf(
                                    "worker.processing.mean" to JsonPrimitive("100ms"),
                                    "worker.queue" to JsonPrimitive(if (name == "queued") 1 else 0),
                                ),
                        )
                    },
            )
        val compiled = fixtures.compile(model, varied)
        assertThat(compiled.diagnostics).isEmpty()
        val warning =
            ModelLinter().lint(requireNotNull(compiled.experiment)).single {
                it.code == "LINT_REJECTION_RISK" && it.path?.startsWith("worker") == true
            }
        assertThat(warning.variant).isEqualTo("loss")
        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/1/overrides/worker.queue")
        val grid =
            varied.copy(
                variants =
                    listOf(
                        varied.variants.last().copy(id = "baseline", overrides = varied.variants.last().overrides - "worker.queue"),
                    ),
                grid = listOf(GridAxis("worker.queue", listOf(JsonPrimitive(0), JsonPrimitive(1)))),
            )
        val swept = fixtures.compile(model, grid)
        assertThat(swept.diagnostics).isEmpty()
        val gridWarning =
            ModelLinter().lint(requireNotNull(swept.experiment)).single {
                it.code == "LINT_REJECTION_RISK" && it.path?.startsWith("worker") == true
            }
        assertThat(gridWarning.variant).isEqualTo("baseline")
        assertThat(gridWarning.pointer).isEqualTo("/grid/0/values/0")
        assertThat(gridWarning.args).containsEntry("points", JsonPrimitive("p0"))
    }

    @Test
    fun `identical findings group across variants and points`() {
        val variants =
            listOf("one", "two").map {
                CompiledVariant(it, it, listOf(CompiledPoint("p0", emptyMap(), graph), CompiledPoint("p1", emptyMap(), graph)))
            }
        val warning = ModelLinter().lint(CompiledExperiment(variants, run)).single { it.code == "LINT_REJECTION_RISK" }
        assertThat(warning.variant).isNull()
        assertThat(warning.args).doesNotContainKey("points")
    }

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ) = linter.lint(experiment(graph)).filter { it.code == "LINT_REJECTION_RISK" }

    private fun withRate(
        rate: Double,
        source: GraphIr = graph,
    ) = source.copy(clients = listOf(source.client.copy(classes = mapOf("default" to LoadProfile.constant(rate)))))

    private fun service(
        path: String = "b",
        handlers: Int = 10,
        meanMs: Double = 100.0,
    ) = ServiceNode(path, handlers, 0, Distribution(DistributionShape.FIXED, meanMs), 0.0, Origin("m.model.json", "/blocks/$path"))

    private fun experiment(graph: GraphIr) =
        CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run)
}
