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
import resiliencelab.core.ir.HealthCheckConfig
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RateLimitConfig
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class ModelLinterHealthCheckCascadeTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val healthCheck = HealthCheckConfig(100.0, 50.0, 1, 1, 1.0)
    private val graph =
        GraphIr(
            ClientNode("client", 0.2, 1_000.0),
            "router",
            listOf("a", "b", "c").map { service(it) },
            emptyList(),
            emptyList(),
            run,
            listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
            listOf("a", "b", "c").map { RouteEdge("route-$it", "router", it) },
        )

    @Test
    fun `removal threshold equality warns without rounding nearby rates`() {
        val diagnostics = warnings(graph)

        assertThat(diagnostics).hasSize(3).allSatisfy { warning ->
            assertThat(warning.severity).isEqualTo(Severity.WARNING)
            assertThat(warning.document).isEqualTo("m.model.json")
            assertThat(warning.pointer).isEqualTo("/blocks/${warning.path}/params/healthCheck")
            assertThat(warning.args)
                .containsEntry("replicas", JsonPrimitive(3))
                .containsEntry("utilization", JsonPrimitive("0.667"))
                .containsEntry("remainingUtilization", JsonPrimitive("1"))
                .containsEntry("threshold", JsonPrimitive("1"))
            assertThat(warning.message).contains("3", "0.667", "1", "unhealthyThreshold", "interval")
        }
        assertThat(warnings(withRate(Math.nextDown(0.2)))).isEmpty()
        assertThat(warnings(withRate(Math.nextUp(0.2)))).hasSize(3)
    }

    @Test
    fun `overload with all replicas singletons zero load and disabled health checks remain silent`() {
        listOf(0.3, Math.nextUp(0.3), 0.4).forEach { rate ->
            val diagnostics = ModelLinter().lint(experiment(withRate(rate)))
            assertThat(diagnostics.filter { it.code == "LINT_HEALTHCHECK_CASCADE" }).isEmpty()
            assertThat(diagnostics.filter { it.code == "LINT_HANDLERS_LITTLE" }).hasSize(3)
        }
        assertThat(warnings(withRate(0.0))).isEmpty()
        assertThat(warnings(graph.copy(services = graph.services.map { it.copy(healthCheck = null) }))).isEmpty()
        assertThat(warnings(graph.copy(services = listOf(service("a")), routes = graph.routes.take(1)))).isEmpty()
    }

    @Test
    fun `largest removable handler capacity is excluded and disabled members cannot be removed`() {
        val changed =
            withRate(0.15).copy(
                services = listOf(service("a").copy(handlers = 1), service("b").copy(handlers = 2), service("c").copy(handlers = 4)),
            )

        assertThat(warnings(changed)).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args)
                .containsEntry("utilization", JsonPrimitive("0.429"))
                .containsEntry("remainingUtilization", JsonPrimitive("1"))
        }
        assertThat(
            warnings(
                changed.copy(
                    services =
                        changed.services.map {
                            it.copy(
                                healthCheck =
                                    if (it.path ==
                                        "c"
                                    ) {
                                        null
                                    } else {
                                        healthCheck
                                    },
                            )
                        },
                ),
            ),
        ).isEmpty()
    }

    @Test
    fun `two clients and request types sum only applicable processing and routing shares`() {
        val changed =
            graph.copy(
                clients =
                    listOf("first", "second").map { name ->
                        graph.client.copy(
                            pathSegments = listOf(name),
                            classes = mapOf("read" to LoadProfile.constant(0.02), "write" to LoadProfile.constant(0.04)),
                        )
                    },
                services =
                    graph.services.map {
                        it.copy(scenario = listOf(ServiceStep.Process(), ServiceStep.Process(fixed(20.0), classes = setOf("write"))))
                    },
                routes = graph.routes + RouteEdge("unused", "router", "a", 100.0, classes = setOf("unused")),
            )

        assertThat(warnings(changed)).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("remainingUtilization", JsonPrimitive("1"))
        }
        assertThat(warnings(changed.copy(clients = changed.clients.take(1)))).isEmpty()
    }

    @Test
    fun `profile peak uses warmup plus measurement and ignores later peaks`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(
                            classes =
                                mapOf(
                                    "default" to LoadProfile(listOf(LoadPoint(0.0, 0.1), LoadPoint(500.0, 0.2), LoadPoint(2_000.0, 0.4))),
                                ),
                        ),
                    ),
            )

        assertThat(warnings(changed)).hasSize(3)
    }

    @Test
    fun `holding uses downstream means and networks excluding retries and stateful policies`() {
        val changed =
            withRate(0.1).copy(
                services =
                    graph.services.map { it.copy(processing = fixed(10.0), rateLimit = RateLimitConfig(0.001, 1)) } +
                        service("tail").copy(handlers = 1_000, processing = fixed(28.0), healthCheck = null, failureProbability = 1.0),
                calls =
                    graph.services.map {
                        CallEdge(
                            "${it.path}-tail",
                            it.path,
                            "tail",
                            fixed(1.0),
                            1.0,
                            10,
                            Backoff(BackoffKind.FIXED, 100.0, 100.0, 2.0),
                            retryBudget = RetryBudgetConfig(0.0, 0.0, 1_000.0),
                        )
                    },
            )

        assertThat(warnings(changed)).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("remainingUtilization", JsonPrimitive("1"))
        }
    }

    @Test
    fun `random routing and replica processing overrides contribute weighted holding times`() {
        val changed =
            withRate(0.1).copy(
                services = listOf(service("a").copy(processing = fixed(60.0)), service("b"), service("c")),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes = graph.routes.map { if (it.to == "a") it.copy(weight = 2.0) else it },
            )

        assertThat(warnings(changed)).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("remainingUtilization", JsonPrimitive("1"))
        }
    }

    @Test
    fun `disjoint singleton request types do not create spare capacity for each other`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(classes = mapOf("read" to LoadProfile.constant(0.075), "write" to LoadProfile.constant(0.075))),
                    ),
                services = graph.services.take(2),
                routes =
                    listOf(
                        RouteEdge("read-a", "router", "a", classes = setOf("read")),
                        RouteEdge("write-b", "router", "b", classes = setOf("write")),
                    ),
            )

        assertThat(warnings(changed)).isEmpty()
    }

    @Test
    fun `overlapping request type routes include shared load but exclude ineligible capacity`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(classes = mapOf("read" to LoadProfile.constant(0.15), "write" to LoadProfile.constant(0.001))),
                    ),
                routes =
                    listOf(
                        RouteEdge("read-a", "router", "a", classes = setOf("read")),
                        RouteEdge("read-b", "router", "b", classes = setOf("read")),
                        RouteEdge("write-b", "router", "b", classes = setOf("write")),
                        RouteEdge("write-c", "router", "c", classes = setOf("write")),
                    ),
            )
        val diagnostics = warnings(changed)

        assertThat(diagnostics.map { it.path }).containsExactlyInAnyOrder("a", "b")
        assertThat(diagnostics).allSatisfy { warning ->
            assertThat(warning.args)
                .containsEntry("requestTypes", JsonPrimitive("read"))
                .containsEntry("replicas", JsonPrimitive(2))
                .containsEntry("remainingUtilization", JsonPrimitive("1.51"))
        }
    }

    @Test
    fun `displayed nominal utilization stays below the threshold near equality`() {
        assertThat(warnings(withRate(0.29999))).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("utilization", JsonPrimitive("0.999"))
        }
    }

    @Test
    fun `zero rate request types do not form additional capacity groups`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(classes = mapOf("read" to LoadProfile.constant(0.2), "write" to LoadProfile.constant(0.0))),
                    ),
                routes =
                    graph.routes.map { it.copy(classes = setOf("read")) } +
                        listOf(
                            RouteEdge("write-a", "router", "a", classes = setOf("write")),
                            RouteEdge("write-b", "router", "b", classes = setOf("write")),
                        ),
            )

        assertThat(warnings(changed)).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("requestTypes", JsonPrimitive("read"))
        }
    }

    @Test
    fun `cascade threshold is configurable and finite positive`() {
        assertThat(warnings(graph, ModelLinter(healthCheckCascadeThreshold = 1.01))).isEmpty()
        assertThat(warnings(withRate(0.1), ModelLinter(healthCheckCascadeThreshold = 0.5))).hasSize(3)
        assertThat(warnings(graph, ModelLinter(healthCheckCascadeThreshold = 0.6))).isEmpty()
        listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).forEach { threshold ->
            assertThatThrownBy { ModelLinter(healthCheckCascadeThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `replica override health checks retain instance identity and variant and grid origins`() {
        val fixtures = ReplicaGroupsTest()
        val source = fixtures.model(3, overrides = """, "replicaOverrides":{"2":{"handlers":4,"healthCheck":{"interval":"100ms"}}}""")
        val model =
            source.copy(
                blocks =
                    source.blocks +
                        (
                            "worker" to
                                source.blocks.getValue("worker").let { block ->
                                    block.copy(
                                        params =
                                            JsonObject(
                                                block.params +
                                                    (
                                                        "processing" to
                                                            JsonObject(
                                                                mapOf("kind" to JsonPrimitive("fixed"), "mean" to JsonPrimitive("247ms")),
                                                            )
                                                    ),
                                            ),
                                    )
                                }
                        ),
            )
        val compiled = fixtures.compile(model)
        assertThat(compiled.diagnostics).isEmpty()
        val warning = ModelLinter().lint(requireNotNull(compiled.experiment)).single { it.code == "LINT_HEALTHCHECK_CASCADE" }
        assertThat(warning.path).isEqualTo("worker#2")
        assertThat(warning.pointer).isEqualTo("/blocks/worker/replicaOverrides/2/healthCheck")
        assertThat(warning.message).contains("worker#2")
        assertThat(warning.args).containsEntry("replica", JsonPrimitive(2))

        val variants =
            fixtures.experiment().copy(
                variants =
                    listOf(
                        Variant("base"),
                        Variant("varied", overrides = mapOf("worker.healthCheck.unhealthyThreshold" to JsonPrimitive(2))),
                    ),
            )
        val varied = fixtures.compile(model, variants)
        assertThat(varied.diagnostics).isEmpty()
        val variedWarnings = ModelLinter().lint(requireNotNull(varied.experiment)).filter { it.code == "LINT_HEALTHCHECK_CASCADE" }
        assertThat(variedWarnings).anySatisfy { finding ->
            assertThat(finding.variant).isEqualTo("varied")
            assertThat(finding.document).isEqualTo("e.experiment.json")
            assertThat(finding.pointer).isEqualTo("/variants/1/overrides/worker.healthCheck.unhealthyThreshold")
        }

        val grid =
            fixtures.experiment().copy(
                grid = listOf(GridAxis("worker.healthCheck.interval", listOf(JsonPrimitive("100ms"), JsonPrimitive("200ms")))),
            )
        val swept = fixtures.compile(model, grid)
        assertThat(swept.diagnostics).isEmpty()
        val sweptWarnings = ModelLinter().lint(requireNotNull(swept.experiment)).filter { it.code == "LINT_HEALTHCHECK_CASCADE" }
        assertThat(sweptWarnings).anySatisfy { finding ->
            assertThat(finding.variant).isEqualTo("baseline")
            assertThat(finding.pointer).isEqualTo("/grid/0/values/1")
            assertThat(finding.args).containsEntry("points", JsonPrimitive("p1"))
        }
    }

    private fun experiment(graph: GraphIr) =
        CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run)

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> = linter.lint(experiment(graph)).filter { it.code == "LINT_HEALTHCHECK_CASCADE" }

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

    private fun service(path: String) =
        ServiceNode(path, 2, 100, fixed(20.0), 0.0, Origin("m.model.json", "/blocks/$path"), healthCheck = healthCheck)
}
