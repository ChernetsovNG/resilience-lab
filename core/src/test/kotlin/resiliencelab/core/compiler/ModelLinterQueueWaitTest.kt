package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.document.GridAxis
import resiliencelab.core.document.Variant
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.PoolerSettings
import resiliencelab.core.ir.RateLimitConfig
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class ModelLinterQueueWaitTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val graph =
        GraphIr(
            ClientNode("client", 0.001, 1_000.0),
            "a",
            listOf(service("a", 10.0).copy(queueCapacity = 0), service("b", 20.0)),
            listOf(call("a-b", "a", "b", 40.0)),
            emptyList(),
            run,
        )

    @Test
    fun `full queue wait uses floating point capacity ratio and strictly exceeds incoming timeout`() {
        val warning = warnings(graph).single()

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.path).isEqualTo("b")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/blocks/b/params/queue")
        assertThat(warning.message).contains("'b'", "50 ms", "40 ms", "'a-b'", "10", "4", "20")
        assertThat(warning.args).containsAllEntriesOf(
            mapOf(
                "reason" to JsonPrimitive("timeout"),
                "target" to JsonPrimitive("b"),
                "connection" to JsonPrimitive("a-b"),
                "estimatedMs" to JsonPrimitive("50"),
                "limitMs" to JsonPrimitive("40"),
                "holdingMs" to JsonPrimitive("20"),
            ),
        )
        assertThat(warnings(graph.copy(calls = listOf(graph.calls.single().copy(timeoutMs = 50.0))))).isEmpty()
        assertThat(warnings(graph.copy(services = graph.services.map { it.copy(queueCapacity = 0) }))).isEmpty()
    }

    @Test
    fun `all processing distributions use their means`() {
        listOf(
            Distribution(DistributionShape.FIXED, 20.125),
            Distribution(DistributionShape.EXPONENTIAL, 20.125),
            Distribution(DistributionShape.LOGNORMAL, 20.125, 10.0),
        ).forEach { processing ->
            val changed = graph.copy(services = listOf(graph.services.first(), graph.services.last().copy(processing = processing)))

            assertThat(warnings(changed).single().args)
                .containsEntry("holdingMs", JsonPrimitive("20.125"))
                .containsEntry("estimatedMs", JsonPrimitive("50.3125"))
        }
    }

    @Test
    fun `rate weighting does not turn exact patience equality into a warning`() {
        val equal =
            graph.copy(
                clients = listOf(graph.client.copy(deadlineMs = 260.0, classes = mapOf("default" to LoadProfile.constant(0.12)))),
                services = listOf(service("a", 13.0).copy(queueCapacity = 80)),
                calls = emptyList(),
            )

        assertThat(warnings(equal)).isEmpty()
        val shorter = equal.copy(clients = equal.clients.map { it.copy(deadlineMs = 259.99999999999994) })
        assertThat(warnings(shorter)).hasSize(1)
    }

    @Test
    fun `decimal processing sums and recurring weighted means preserve exact patience boundaries`() {
        val decimal =
            graph.copy(
                clients = listOf(graph.client.copy(deadlineMs = 0.3)),
                services =
                    listOf(
                        service(
                            "a",
                            0.1,
                        ).copy(queueCapacity = 4, scenario = listOf(ServiceStep.Process(), ServiceStep.Process(fixed(0.2)))),
                    ),
                calls = emptyList(),
            )
        val recurring =
            decimal.copy(
                clients =
                    listOf(
                        graph.client.copy(
                            deadlineMs = 25.0,
                            classes = mapOf("read" to LoadProfile.constant(0.001), "write" to LoadProfile.constant(0.002)),
                        ),
                    ),
                services =
                    listOf(
                        service("a", 10.0).copy(
                            queueCapacity = 6,
                            scenario =
                                listOf(
                                    ServiceStep.Process(classes = setOf("read")),
                                    ServiceStep.Process(fixed(20.0), classes = setOf("write")),
                                ),
                        ),
                    ),
            )

        listOf(decimal, recurring).forEach { equal ->
            assertThat(warnings(equal)).isEmpty()
            val shorter = equal.copy(clients = equal.clients.map { it.copy(deadlineMs = Math.nextDown(it.deadlineMs)) })
            assertThat(warnings(shorter)).hasSize(1)
        }
    }

    @Test
    fun `rounded routing shares do not warn when the reported weighted wait equals patience`() {
        val mixed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(entry = "router", deadlineMs = 20.0, classes = mapOf("read" to LoadProfile.constant(0.12))),
                        graph.client.copy(
                            pathSegments = listOf("direct"),
                            deadlineMs = 20.0,
                            classes = mapOf("write" to LoadProfile.constant(0.04)),
                        ),
                    ),
                services =
                    listOf(
                        service("a", 10.0).copy(
                            queueCapacity = 4,
                            scenario =
                                listOf(
                                    ServiceStep.Process(classes = setOf("read")),
                                    ServiceStep.Process(fixed(30.0), classes = setOf("write")),
                                ),
                        ),
                        service("c", 10.0).copy(queueCapacity = 0),
                        service("d", 10.0).copy(queueCapacity = 0),
                    ),
                calls = emptyList(),
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf(RouteEdge("a", "router", "a"), RouteEdge("c", "router", "c"), RouteEdge("d", "router", "d")),
            )

        assertThat(warnings(mixed)).isEmpty()
        val shorter = mixed.copy(clients = mixed.clients.map { it.copy(deadlineMs = Math.nextDown(20.0)) })
        assertThat(warnings(shorter).single().args).containsEntry("estimatedMs", JsonPrimitive("20"))
    }

    @Test
    fun `holding includes downstream networks and processing while ignoring retries policies and incoming network`() {
        BackoffKind.entries.forEach { kind ->
            val changed =
                graph.copy(
                    services =
                        listOf(
                            graph.services.first(),
                            service("b", 10.0).copy(queueCapacity = 2, rateLimit = RateLimitConfig(0.0001, 1)),
                            service("c", 100.0).copy(queueCapacity = 0, failureProbability = 1.0),
                        ),
                    calls =
                        listOf(
                            graph.calls.single().copy(timeoutMs = 57.0, network = fixed(200.0), pool = CallPool(1, 1.0)),
                            call("b-c", "b", "c", 1.0).copy(
                                network = fixed(3.0),
                                attempts = 7,
                                backoff = Backoff(kind, 1_000.0, 1_000.0, 2.0),
                            ),
                        ),
                )

            assertThat(warnings(changed).single().args)
                .containsEntry("holdingMs", JsonPrimitive("116"))
                .containsEntry("estimatedMs", JsonPrimitive("58"))
        }
    }

    @Test
    fun `entry uses the shortest deadline of clients whose request types reach it`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(pathSegments = listOf("patient"), deadlineMs = 100.0),
                        graph.client.copy(pathSegments = listOf("impatient"), deadlineMs = 40.125),
                    ),
                services = listOf(service("a", 20.0)),
                calls = emptyList(),
            )

        val warning = warnings(changed).single()

        assertThat(warning.args)
            .containsEntry("reason", JsonPrimitive("deadline"))
            .containsEntry("client", JsonPrimitive("impatient"))
            .containsEntry("limitMs", JsonPrimitive("40.125"))
        assertThat(warning.message).contains("deadline", "impatient", "40.125 ms")
        assertThat(warnings(changed.copy(clients = changed.clients.map { it.copy(deadlineMs = 50.0) }))).isEmpty()
    }

    @Test
    fun `shared queue averages holding by maximum profile rates across clients and request types`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(
                            classes =
                                mapOf(
                                    "read" to LoadProfile.constant(0.001),
                                    "write" to LoadProfile(listOf(LoadPoint(0.0, 0.0), LoadPoint(1_000.0, 0.003))),
                                ),
                        ),
                        graph.client.copy(pathSegments = listOf("second"), classes = mapOf("read" to LoadProfile.constant(0.002))),
                    ),
                services =
                    listOf(
                        graph.services.first(),
                        service("b", 10.0).copy(
                            scenario = listOf(ServiceStep.Process(), ServiceStep.Process(fixed(20.0), classes = setOf("write"))),
                        ),
                    ),
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("holdingMs", JsonPrimitive("20"))
            .containsEntry("estimatedMs", JsonPrimitive("50"))
        assertThat(
            warnings(changed.copy(clients = changed.clients.map { it.copy(classes = mapOf("read" to LoadProfile.constant(0.001))) })),
        ).isEmpty()
    }

    @Test
    fun `shared target uses shortest applicable call timeout and ignores unused calls`() {
        val changed =
            graph.copy(
                clients = graph.clients + graph.client.copy(pathSegments = listOf("second"), entry = "c"),
                services =
                    listOf(
                        graph.services.first().copy(scenario = listOf(ServiceStep.Call("a-b"))),
                        graph.services.last(),
                        service("c", 1.0).copy(queueCapacity = 0),
                    ),
                calls =
                    listOf(
                        graph.calls.single().copy(timeoutMs = 100.0),
                        call("c-b", "c", "b", 40.0),
                        call("unused", "a", "b", 1.0),
                    ),
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("connection", JsonPrimitive("c-b"))
            .containsEntry("limitMs", JsonPrimitive("40"))
    }

    @Test
    fun `router class filters choose only applicable targets and their incoming call patience`() {
        val changed =
            graph.copy(
                clients = listOf(graph.client.copy(classes = mapOf("read" to LoadProfile.constant(0.001)))),
                services = graph.services + service("unused", 100.0),
                calls = listOf(graph.calls.single().copy(to = "router")),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes =
                    listOf(
                        RouteEdge("read", "router", "b", 1.0, classes = setOf("read")),
                        RouteEdge("write", "router", "unused", 9.0, classes = setOf("write")),
                    ),
            )

        assertThat(warnings(changed).map { it.path }).containsExactly("b")
        assertThat(warnings(changed).single().args).containsEntry("connection", JsonPrimitive("a-b"))
    }

    @Test
    fun `entry router deadlines apply only to targets reached by that clients request types`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(entry = "router", deadlineMs = 40.0, classes = mapOf("read" to LoadProfile.constant(0.001))),
                        graph.client.copy(
                            pathSegments = listOf("second"),
                            entry = "router",
                            deadlineMs = 100.0,
                            classes = mapOf("write" to LoadProfile.constant(0.001)),
                        ),
                    ),
                services = listOf(service("a", 20.0), service("b", 20.0)),
                calls = emptyList(),
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes =
                    listOf(
                        RouteEdge("read", "router", "a", classes = setOf("read")),
                        RouteEdge("write", "router", "b", classes = setOf("write")),
                    ),
            )

        assertThat(warnings(changed).map { it.path }).containsExactly("a")
        val idle = changed.copy(clients = changed.clients.map { it.copy(classes = mapOf("read" to LoadProfile.constant(0.0))) })
        assertThat(warnings(idle)).isEmpty()
    }

    @Test
    fun `queue warning checks database capacity and excludes pooler slots`() {
        val database = graph.copy(services = listOf(graph.services.first(), graph.services.last().copy(type = "database")))

        assertThat(warnings(database).single().pointer).isEqualTo("/blocks/b/params/queue")
        val pooler =
            graph.copy(
                services =
                    listOf(
                        graph.services.first(),
                        graph.services.last().copy(type = "pooler", pooler = PoolerSettings(4, 1_000.0)),
                        service("c", 20.0).copy(queueCapacity = 0),
                    ),
                calls = graph.calls + call("b-c", "b", "c", 1_000.0),
            )
        assertThat(warnings(pooler)).isEmpty()
    }

    @Test
    fun `replica queue override warns only for that instance with its model origin`() {
        val fixtures = ReplicaGroupsTest()
        val source = fixtures.model(2, overrides = """, "replicaOverrides":{"2":{"queue":100,"processing":{"mean":"9ms"}}}""")
        val compiled = fixtures.compile(source)
        assertThat(compiled.diagnostics).isEmpty()
        val warning = ModelLinter().lint(requireNotNull(compiled.experiment)).single { it.code == "LINT_QUEUE_WAIT" }

        assertThat(warning.path).isEqualTo("worker#2")
        assertThat(warning.pointer).isEqualTo("/blocks/worker/replicaOverrides/2/queue")
        assertThat(warning.message).contains("Replica 'worker#2'", "gateway-to-worker")
        assertThat(warning.args).containsEntry("replica", JsonPrimitive(2)).containsEntry("target", JsonPrimitive("worker"))
    }

    @Test
    fun `queue wait threshold is configurable with equality allowed and rejects invalid values`() {
        val configurable = ModelLinter(queueWaitThreshold = 1.25)

        assertThat(warnings(graph, configurable)).isEmpty()
        val above = graph.copy(calls = listOf(graph.calls.single().copy(timeoutMs = 39.0)))
        assertThat(warnings(above, configurable).single().args).containsEntry("threshold", JsonPrimitive("1.25"))
        val fractional =
            graph.copy(
                clients = listOf(graph.client.copy(deadlineMs = Math.nextDown(0.2))),
                services = listOf(service("a", 0.3).copy(queueCapacity = 4)),
                calls = emptyList(),
            )
        assertThat(warnings(fractional, ModelLinter(queueWaitThreshold = 1.5))).hasSize(1)
        listOf(0.0, -1.0, 0.99, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).forEach { threshold ->
            assertThatThrownBy { ModelLinter(queueWaitThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `variant queue override retains its origin and warns only at affected grid points`() {
        val fixtures = ReplicaGroupsTest()
        val experiment =
            fixtures.experiment().copy(
                variants = listOf(Variant("large-queue", overrides = mapOf("worker.queue" to JsonPrimitive(100)))),
                grid = listOf(GridAxis("worker.handlers", listOf(JsonPrimitive(1), JsonPrimitive(100)))),
            )
        val compiled = fixtures.compile(fixtures.model(1), experiment)
        assertThat(compiled.diagnostics).isEmpty()

        val warning = ModelLinter().lint(requireNotNull(compiled.experiment)).single { it.code == "LINT_QUEUE_WAIT" }

        assertThat(warning.variant).isEqualTo("large-queue")
        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/0/overrides/worker.queue")
        assertThat(warning.args).containsEntry("points", JsonPrimitive("p0"))
        val withoutGrid = fixtures.compile(fixtures.model(1), experiment.copy(grid = emptyList()))
        val solo = ModelLinter().lint(requireNotNull(withoutGrid.experiment)).single { it.code == "LINT_QUEUE_WAIT" }
        assertThat(solo.variant).isEqualTo("large-queue")
        assertThat(solo.pointer).isEqualTo("/variants/0/overrides/worker.queue")
    }

    @Test
    fun `queue grid values retain the axis origin and affected point`() {
        val fixtures = ReplicaGroupsTest()
        val experiment =
            fixtures.experiment().copy(grid = listOf(GridAxis("worker.queue", listOf(JsonPrimitive(0), JsonPrimitive(100)))))
        val compiled = fixtures.compile(fixtures.model(1), experiment)
        assertThat(compiled.diagnostics).isEmpty()

        val warning = ModelLinter().lint(requireNotNull(compiled.experiment)).single { it.code == "LINT_QUEUE_WAIT" }

        assertThat(warning.pointer).isEqualTo("/grid/0/values/1")
        assertThat(warning.variant).isEqualTo("baseline")
        assertThat(warning.args).containsEntry("points", JsonPrimitive("p1"))
    }

    @Test
    fun `identical model queue warnings group across variants`() {
        val variants = listOf("one", "two").map { CompiledVariant(it, it, listOf(CompiledPoint("p0", emptyMap(), graph))) }
        val warning = ModelLinter().lint(CompiledExperiment(variants, run)).single { it.code == "LINT_QUEUE_WAIT" }

        assertThat(warning.variant).isNull()
    }

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> =
        linter
            .lint(CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run))
            .filter { it.code == "LINT_QUEUE_WAIT" }

    private fun fixed(meanMs: Double) = Distribution(DistributionShape.FIXED, meanMs)

    private fun service(
        path: String,
        meanMs: Double,
    ) = ServiceNode(path, 4, 10, fixed(meanMs), 0.0, Origin("m.model.json", "/blocks/$path"))

    private fun call(
        path: String,
        from: String,
        to: String,
        timeoutMs: Double,
    ) = CallEdge(path, from, to, fixed(0.0), timeoutMs, 1, Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0))
}
