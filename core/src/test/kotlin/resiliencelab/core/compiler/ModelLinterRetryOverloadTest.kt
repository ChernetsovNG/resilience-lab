package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonObject
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

class ModelLinterRetryOverloadTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val graph =
        GraphIr(
            ClientNode("client", 0.1, 1_000.0),
            "a",
            listOf(service("a", 0.0), service("b", 20.0)),
            listOf(call("a-b", "a", "b", 2)),
            emptyList(),
            run,
        )

    @Test
    fun `equality warns with worst arrival rate utilization and nearest retry origin`() {
        val warning = warnings(graph).single()

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.path).isEqualTo("a-b")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/a-b/params/attempts")
        assertThat(warning.args).containsAllEntriesOf(
            mapOf(
                "target" to JsonPrimitive("b"),
                "ratePerSecond" to JsonPrimitive("200"),
                "utilization" to JsonPrimitive("1"),
                "holdingMs" to JsonPrimitive("20"),
                "attemptChain" to JsonPrimitive("a-b: 2"),
            ),
        )
        assertThat(warning.message).contains("'b'", "200", "1", "a-b: 2")
        assertThat(warnings(withRate(graph, 0.099999))).isEmpty()
        assertThat(warnings(graph.copy(calls = listOf(graph.calls.single().copy(attempts = 1))))).isEmpty()
        assertThat(warnings(withRate(graph, 0.0))).isEmpty()
    }

    @Test
    fun `nested attempts multiply every downstream path and locate the last retrying call`() {
        val nested =
            graph.copy(
                services = graph.services + service("c", 20.0),
                calls = graph.calls + call("b-c", "b", "c", 3),
            )
        val warning = warnings(nested).single { it.args?.get("target") == JsonPrimitive("c") }

        assertThat(warning.path).isEqualTo("b-c")
        assertThat(warning.args)
            .containsEntry("ratePerSecond", JsonPrimitive("600"))
            .containsEntry("utilization", JsonPrimitive("3"))
            .containsEntry("attemptChain", JsonPrimitive("a-b: 2 × b-c: 3"))
        val noInnerRetry = nested.copy(calls = listOf(nested.calls.first(), nested.calls.last().copy(attempts = 1)))
        assertThat(warnings(noInnerRetry).single { it.args?.get("target") == JsonPrimitive("c") }.path).isEqualTo("a-b")
    }

    @Test
    fun `holding uses processing means and downstream networks independently of backoff and failures`() {
        DistributionShape.entries.forEach { shape ->
            BackoffKind.entries.forEach { kind ->
                val changed =
                    graph
                        .copy(
                            services =
                                listOf(
                                    graph.services.first(),
                                    service("b", 10.0),
                                    service("c", 20.0).copy(failureProbability = 1.0),
                                ),
                            calls =
                                listOf(
                                    graph.calls.single().copy(network = fixed(200.0), backoff = Backoff(kind, 900.0, 1_000.0, 2.0)),
                                    call("b-c", "b", "c", 1).copy(network = Distribution(shape, 3.0, 1.0)),
                                ),
                        ).let { value ->
                            value.copy(
                                services = value.services.map { it.copy(processing = Distribution(shape, it.processing.meanMs, 1.0)) },
                            )
                        }
                val warning = warnings(changed).single { it.args?.get("target") == JsonPrimitive("b") }
                assertThat(warning.args)
                    .containsEntry("holdingMs", JsonPrimitive("36"))
                    .containsEntry("utilization", JsonPrimitive("1.8"))
            }
        }
    }

    @Test
    fun `profile maximum is taken only over the arrival interval`() {
        val profile = LoadProfile(listOf(LoadPoint(0.0, 0.01), LoadPoint(500.0, 0.1), LoadPoint(2_000.0, 0.4)))
        val changed = graph.copy(clients = listOf(graph.client.copy(classes = mapOf("default" to profile))))

        assertThat(warnings(changed).single().args).containsEntry("ratePerSecond", JsonPrimitive("400"))
    }

    @Test
    fun `all clients and request types share one retry budget minimum`() {
        val clients =
            listOf("first", "second").map { name ->
                graph.client.copy(
                    pathSegments = listOf(name),
                    classes =
                        mapOf(
                            "read" to LoadProfile.constant(0.1),
                            "write" to LoadProfile.constant(0.1),
                        ),
                )
            }
        val changed =
            graph.copy(
                clients = clients,
                services = listOf(graph.services.first(), service("b", 8.0)),
                calls = listOf(graph.calls.single().copy(attempts = 5, retryBudget = RetryBudgetConfig(0.1, 0.06, 1_000.0))),
            )
        val warning = warnings(changed).single()

        // 400 first attempts/s + 40 proportional retries/s + one shared 60 retries/s floor.
        assertThat(warning.args)
            .containsEntry("ratePerSecond", JsonPrimitive("500"))
            .containsEntry("utilization", JsonPrimitive("1"))
            .containsEntry("budgetLimited", JsonPrimitive("a-b"))
        val blocked = changed.copy(calls = listOf(changed.calls.single().copy(retryBudget = RetryBudgetConfig(0.0, 0.0, 1_000.0))))
        assertThat(warnings(blocked)).isEmpty()
        assertThat(
            warnings(changed.copy(clients = clients.map { it.copy(classes = mapOf("read" to LoadProfile.constant(0.0))) })),
        ).isEmpty()
    }

    @Test
    fun `downstream budget uses amplified first attempts and is applied before router splitting`() {
        val changed =
            graph.copy(
                services = listOf(graph.services.first(), service("b", 0.0), service("c", 20.0), service("d", 20.0)),
                calls =
                    graph.calls + call("b-targets", "b", "router", 5).copy(retryBudget = RetryBudgetConfig(0.5, 0.1, 1_000.0)),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes = listOf(RouteEdge("c", "router", "c", 1.0), RouteEdge("d", "router", "d", 1.0)),
            )
        val findings = warnings(changed).filter { it.args?.get("target") in setOf(JsonPrimitive("c"), JsonPrimitive("d")) }

        // Upstream retries give 200 first attempts/s. Budget permits 100 + 100 retries/s, split 200/s each.
        assertThat(findings).hasSize(2)
        assertThat(findings).allSatisfy { finding ->
            assertThat(finding.args)
                .containsEntry("ratePerSecond", JsonPrimitive("200"))
                .containsEntry("utilization", JsonPrimitive("1"))
                .containsEntry("budgetLimited", JsonPrimitive("b-targets"))
        }
    }

    @Test
    fun `different request type holding times contribute weighted demand only on applicable steps`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(
                            classes =
                                mapOf(
                                    "read" to LoadProfile.constant(0.03),
                                    "write" to LoadProfile.constant(0.02),
                                ),
                        ),
                    ),
                services =
                    listOf(
                        graph.services.first(),
                        service("b", 20.0).copy(
                            scenario = listOf(ServiceStep.Process(), ServiceStep.Process(fixed(50.0), classes = setOf("write"))),
                        ),
                    ),
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("100"))
            .containsEntry("holdingMs", JsonPrimitive("40"))
            .containsEntry("utilization", JsonPrimitive("1"))
    }

    @Test
    fun `converging router branches sum their own amplified shares`() {
        val changed =
            graph.copy(
                services = listOf(service("a", 0.0), service("left", 0.0), service("right", 0.0), service("b", 20.0)),
                calls = listOf(call("a-router", "a", "router", 1), call("left-b", "left", "b", 3), call("right-b", "right", "b", 1)),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes = listOf(RouteEdge("left", "router", "left", 1.0), RouteEdge("right", "router", "right", 1.0)),
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("200"))
            .containsEntry("utilization", JsonPrimitive("1"))
    }

    @Test
    fun `entry router and request type filters exclude unreachable processing and calls`() {
        val changed =
            graph
                .copy(
                    clients = listOf(graph.client.copy(entry = "entry", classes = mapOf("read" to LoadProfile.constant(0.1)))),
                    services = graph.services + service("unused", 10_000.0),
                    calls = graph.calls + call("unused", "a", "unused", 1_000),
                    routers = listOf(RouterNode("entry", RoutingPolicy.ROUND_ROBIN)),
                    routes =
                        listOf(
                            RouteEdge("read", "entry", "a", classes = setOf("read")),
                            RouteEdge("write", "entry", "unused", classes = setOf("write")),
                        ),
                ).let { value ->
                    value.copy(
                        services =
                            value.services.map {
                                if (it.path ==
                                    "a"
                                ) {
                                    it.copy(scenario = listOf(ServiceStep.Call("a-b")))
                                } else {
                                    it
                                }
                            },
                    )
                }

        assertThat(warnings(changed).single().args).containsEntry("target", JsonPrimitive("b"))
    }

    @Test
    fun `rate limit caps accepted utilization and equality still warns`() {
        val changed =
            graph.copy(
                services = listOf(graph.services.first(), graph.services.last().copy(rateLimit = RateLimitConfig(0.15, 100))),
            )

        assertThat(warnings(changed)).isEmpty()
        val equality =
            changed.copy(
                services = listOf(changed.services.first(), changed.services.last().copy(rateLimit = RateLimitConfig(0.2, 1))),
            )
        assertThat(warnings(equality).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("200"))
            .containsEntry("utilization", JsonPrimitive("1"))
    }

    @Test
    fun `database uses connection capacity and pooler is excluded`() {
        val database = graph.copy(services = listOf(graph.services.first(), graph.services.last().copy(type = "database")))
        assertThat(warnings(database)).hasSize(1)
        val pooler =
            graph.copy(
                services = listOf(graph.services.first(), graph.services.last().copy(type = "pooler", pooler = PoolerSettings(4, 1_000.0))),
            )
        assertThat(warnings(pooler)).isEmpty()
    }

    @Test
    fun `replica overrides change only that instances load and retain incoming attempts origin`() {
        val fixtures = ReplicaGroupsTest()
        val model = fixtures.model(2, overrides = """, "replicaOverrides":{"2":{"handlers":1,"processing":{"mean":"100ms"}}}""")
        val changed =
            model.copy(
                connections =
                    model.connections.map {
                        if (it.id ==
                            "gateway-to-worker"
                        ) {
                            it.copy(params = JsonObject(it.params + ("attempts" to JsonPrimitive(3))))
                        } else {
                            it
                        }
                    },
            )
        val compiled = fixtures.compile(changed)
        assertThat(compiled.diagnostics).isEmpty()
        val warning = ModelLinter().lint(requireNotNull(compiled.experiment)).single { it.code == "LINT_RETRY_OVERLOAD" }

        assertThat(warning.path).isEqualTo("gateway-to-worker")
        assertThat(warning.pointer).isEqualTo("/connections/1/params/attempts")
        assertThat(warning.message).contains("worker#2")
        assertThat(warning.args).containsEntry("replica", JsonPrimitive(2))
    }

    @Test
    fun `variant attempts and grid values retain precise origins and affected points`() {
        val fixtures = ReplicaGroupsTest()
        val model = fixtures.model(1, overrides = """, "replicaOverrides":{"1":{"processing":{"mean":"100ms"}}}""")
        val experiment =
            fixtures.experiment().copy(
                variants = listOf(Variant("retry", overrides = mapOf("gateway-to-worker.attempts" to JsonPrimitive(2)))),
                grid = listOf(GridAxis("worker.handlers", listOf(JsonPrimitive(1), JsonPrimitive(100)))),
            )
        val compiled = fixtures.compile(model, experiment)
        assertThat(compiled.diagnostics).isEmpty()
        val warning = ModelLinter().lint(requireNotNull(compiled.experiment)).single { it.code == "LINT_RETRY_OVERLOAD" }

        assertThat(warning.variant).isEqualTo("retry")
        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/0/overrides/gateway-to-worker.attempts")
        assertThat(warning.args).containsEntry("points", JsonPrimitive("p0"))
        val grid =
            fixtures.experiment().copy(
                grid = listOf(GridAxis("gateway-to-worker.attempts", listOf(JsonPrimitive(1), JsonPrimitive(2)))),
            )
        val gridResult = fixtures.compile(model, grid)
        val gridWarning = ModelLinter().lint(requireNotNull(gridResult.experiment)).single { it.code == "LINT_RETRY_OVERLOAD" }
        assertThat(gridWarning.pointer).isEqualTo("/grid/0/values/1")
        assertThat(gridWarning.args).containsEntry("points", JsonPrimitive("p1"))
    }

    @Test
    fun `identical model warnings group across variants`() {
        val variants = listOf("one", "two").map { CompiledVariant(it, it, listOf(CompiledPoint("p0", emptyMap(), graph))) }
        val warning = ModelLinter().lint(CompiledExperiment(variants, run)).single { it.code == "LINT_RETRY_OVERLOAD" }
        assertThat(warning.variant).isNull()
    }

    @Test
    fun `overload threshold is configurable and rejects nonpositive or nonfinite values`() {
        assertThat(warnings(graph, ModelLinter(retryOverloadThreshold = 1.01))).isEmpty()
        assertThat(warnings(graph, ModelLinter(retryOverloadThreshold = 1.0))).hasSize(1)
        assertThat(warnings(withRate(graph, 0.05), ModelLinter(retryOverloadThreshold = 0.5))).hasSize(1)
        listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).forEach { threshold ->
            assertThatThrownBy { ModelLinter(retryOverloadThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `equal router shares preserve utilization equality for every replica`() {
        val changed =
            withRate(graph, 0.3).copy(
                services = listOf(graph.services.first(), service("b", 20.0), service("c", 20.0), service("d", 20.0)),
                calls = listOf(graph.calls.single().copy(to = "router")),
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf(RouteEdge("b", "router", "b"), RouteEdge("c", "router", "c"), RouteEdge("d", "router", "d")),
            )
        assertThat(warnings(changed)).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args)
                .containsEntry("ratePerSecond", JsonPrimitive("200"))
                .containsEntry("utilization", JsonPrimitive("1"))
        }
    }

    @Test
    fun `shared budget preserves exact capacity when its factor is a recurring decimal`() {
        val changed =
            graph.copy(
                clients = listOf("first", "second", "third").map { graph.client.copy(pathSegments = listOf(it)) },
                services = listOf(graph.services.first(), service("b", 10.0)),
                calls = listOf(graph.calls.single().copy(retryBudget = RetryBudgetConfig(0.0, 0.1, 1_000.0))),
            )
        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("400"))
            .containsEntry("utilization", JsonPrimitive("1"))
    }

    @Test
    fun `random router uses exact original weight ratios at the capacity boundary`() {
        val changed =
            withRate(graph, 0.4).copy(
                services = listOf(graph.services.first(), service("b", 20.0), service("c", 0.0)),
                calls = listOf(graph.calls.single().copy(to = "router")),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes = listOf(RouteEdge("b", "router", "b", 1.0), RouteEdge("c", "router", "c", 3.0)),
            )
        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("200"))
            .containsEntry("utilization", JsonPrimitive("1"))
    }

    @Test
    fun `recurring router thirds preserve equality without treating a lower input as equal`() {
        fun routed(rate: Double) =
            withRate(graph, rate).copy(
                services = listOf(graph.services.first(), service("b", 12.0), service("c", 12.0), service("d", 12.0)),
                calls = listOf(graph.calls.single().copy(to = "router")),
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf(RouteEdge("b", "router", "b"), RouteEdge("c", "router", "c"), RouteEdge("d", "router", "d")),
            )
        assertThat(warnings(routed(0.5))).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("utilization", JsonPrimitive("1"))
        }
        assertThat(warnings(routed(Math.nextDown(0.5)))).isEmpty()
    }

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> =
        linter
            .lint(CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run))
            .filter { it.code == "LINT_RETRY_OVERLOAD" }

    private fun withRate(
        graph: GraphIr,
        rate: Double,
    ) = graph.copy(clients = graph.clients.map { it.copy(classes = mapOf("default" to LoadProfile.constant(rate))) })

    private fun fixed(meanMs: Double) = Distribution(DistributionShape.FIXED, meanMs)

    private fun service(
        path: String,
        meanMs: Double,
    ) = ServiceNode(path, 4, 0, fixed(meanMs), 0.0, Origin("m.model.json", "/blocks/$path"))

    private fun call(
        path: String,
        from: String,
        to: String,
        attempts: Int,
    ) = CallEdge(
        path,
        from,
        to,
        fixed(0.0),
        1_000.0,
        attempts,
        Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0),
        Origin("m.model.json", "/connections/$path"),
    )
}
