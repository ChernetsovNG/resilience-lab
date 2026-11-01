package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.GridAxis
import resiliencelab.core.document.Variant
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.CircuitBreakerConfig
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FallbackConfig
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.PoolerSettings
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class ModelLinterPoolDemandTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L)
    private val graph =
        GraphIr(
            ClientNode("client", 0.1, 10_000.0),
            "caller",
            listOf(service("caller", 200.0), service("db", 20.0)),
            listOf(call("caller-db", "caller", "db")),
            emptyList(),
            run,
        )

    @Test
    fun `equality warns at the call pool size with demand rate and caller capacity`() {
        val warning = warnings(graph).single()

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.path).isEqualTo("caller-db")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/caller-db/params/pool/size")
        assertThat(warning.args).containsAllEntriesOf(
            mapOf(
                "target" to JsonPrimitive("caller-db"),
                "demand" to JsonPrimitive("4"),
                "size" to JsonPrimitive(4),
                "ratePerSecond" to JsonPrimitive("100"),
                "holdingMs" to JsonPrimitive("40"),
                "threshold" to JsonPrimitive("1"),
                "handlers" to JsonPrimitive(8),
                "reason" to JsonPrimitive("limitsHandlers"),
            ),
        )
        assertThat(warning.message).contains("pool", "parallelism", "8")
        assertThat(warnings(withRate(Math.nextDown(0.1)))).isEmpty()
        assertThat(warnings(withRate(Math.nextUp(0.1)))).hasSize(1)
        assertThat(warnings(withRate(0.0))).isEmpty()
    }

    @Test
    fun `pool at least as large as handlers has no parallelism qualification`() {
        val changed = graph.copy(services = listOf(graph.services.first().copy(handlers = 4), graph.services.last()))

        assertThat(warnings(changed).single().args).doesNotContainKeys("reason", "handlers")
        assertThat(warnings(changed).single().message).doesNotContain("parallelism")
    }

    @Test
    fun `holding is capped by timeout and excludes acquiring a connection and caller processing`() {
        val changed = graph.copy(calls = listOf(graph.calls.single().copy(timeoutMs = 20.0, pool = CallPool(2, 0.0))))

        assertThat(warnings(changed).single().args)
            .containsEntry("demand", JsonPrimitive("2"))
            .containsEntry("holdingMs", JsonPrimitive("20"))
        assertThat(warnings(changed.copy(calls = listOf(changed.calls.single().copy(pool = CallPool(3)))))).isEmpty()
    }

    @Test
    fun `all distribution means include downstream processing and networks without retries or policy state`() {
        DistributionShape.entries.forEach { shape ->
            val changed =
                graph.copy(
                    services =
                        graph.services + service("tail", 30.0).copy(processing = Distribution(shape, 30.0, 1.0)),
                    calls =
                        listOf(
                            graph.calls.single().copy(
                                network = Distribution(shape, 10.0, 1.0),
                                pool = CallPool(8),
                                attempts = 10,
                                backoff = Backoff(BackoffKind.FIXED, 500.0, 500.0, 2.0),
                                retryBudget = RetryBudgetConfig(0.0, 0.0, 1_000.0),
                                circuitBreaker = CircuitBreakerConfig(0.5, 1, 10, 1_000.0, 1),
                                fallback = FallbackConfig(setOf("timeout"), 500.0),
                            ),
                            call("db-tail", "db", "tail").copy(network = Distribution(shape, 5.0, 1.0), pool = null),
                        ),
                )
            val warning = warnings(changed).single()
            assertThat(warning.args)
                .containsEntry("holdingMs", JsonPrimitive("80"))
                .containsEntry("demand", JsonPrimitive("8"))
                .containsEntry("ratePerSecond", JsonPrimitive("100"))
        }
    }

    @Test
    fun `two clients and two request types sum rate weighted demand using applicable processing steps`() {
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
                        graph.services.first(),
                        graph.services.last().copy(
                            scenario =
                                listOf(
                                    ServiceStep.Process(fixed(20.0), classes = setOf("read")),
                                    ServiceStep.Process(fixed(60.0), classes = setOf("write")),
                                    ServiceStep.Process(fixed(999.0), classes = setOf("unused")),
                                ),
                        ),
                    ),
                calls = listOf(graph.calls.single().copy(network = fixed(0.0))),
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("ratePerSecond", JsonPrimitive("100"))
            .containsEntry("holdingMs", JsonPrimitive("44"))
            .containsEntry("demand", JsonPrimitive("4.4"))
    }

    @Test
    fun `profile maximum covers only the run and calls apply only to their request types`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(
                            classes =
                                mapOf(
                                    "read" to
                                        LoadProfile(
                                            listOf(
                                                LoadPoint(0.0, 0.01),
                                                LoadPoint(500.0, 0.1),
                                                LoadPoint(1_000.0, 0.1),
                                                LoadPoint(2_000.0, 1.0),
                                            ),
                                        ),
                                    "write" to LoadProfile.constant(10.0),
                                ),
                        ),
                    ),
                services =
                    listOf(
                        graph.services.first().copy(scenario = listOf(ServiceStep.Call("caller-db", setOf("read")))),
                        graph.services.last(),
                    ),
            )

        assertThat(warnings(changed).single().args).containsEntry("ratePerSecond", JsonPrimitive("100"))
    }

    @Test
    fun `unpooled unused and unreachable connections do not warn`() {
        assertThat(warnings(graph.copy(calls = listOf(graph.calls.single().copy(pool = null))))).isEmpty()
        val unused = graph.copy(services = listOf(graph.services.first().copy(scenario = emptyList()), graph.services.last()))
        assertThat(warnings(unused)).isEmpty()
        val unreachable =
            unused.copy(
                services = unused.services + service("isolated", 0.0),
                calls = unused.calls + call("isolated-db", "isolated", "db").copy(pool = CallPool(1)),
            )
        assertThat(warnings(unreachable)).isEmpty()
    }

    @Test
    fun `a pool before a router counts its source once using the longest target path`() {
        val changed =
            graph.copy(
                services = listOf(graph.services.first()) + listOf(20.0, 40.0, 60.0).mapIndexed { i, ms -> service("db$i", ms) },
                calls = listOf(graph.calls.single().copy(to = "router", network = fixed(0.0), pool = CallPool(6))),
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = (0..2).map { RouteEdge("route$it", "router", "db$it") },
            )

        assertThat(warnings(changed).single().args)
            .containsEntry("demand", JsonPrimitive("6"))
            .containsEntry("holdingMs", JsonPrimitive("60"))
            .containsEntry("ratePerSecond", JsonPrimitive("100"))
    }

    @Test
    fun `router thirds keep exact pool threshold equality and request type filters`() {
        fun routed(rate: Double) =
            graph.copy(
                clients = listOf(graph.client.copy(entry = "router", classes = mapOf("read" to LoadProfile.constant(rate)))),
                services = (1..3).map { service("caller#$it", 0.0) } + service("db", 12.0),
                calls = (1..3).map { call("caller-db#$it", "caller#$it", "db").copy(network = fixed(0.0), pool = CallPool(2)) },
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes =
                    (1..3).map { RouteEdge("route$it", "router", "caller#$it", classes = setOf("read")) } +
                        RouteEdge("write", "router", "caller#1", 100.0, classes = setOf("write")),
            )

        assertThat(warnings(routed(0.5))).hasSize(3).allSatisfy { warning ->
            assertThat(warning.args).containsEntry("demand", JsonPrimitive("2"))
            assertThat(warning.message).contains("caller#")
        }
        assertThat(warnings(routed(Math.nextDown(0.5)))).isEmpty()
    }

    @Test
    fun `pooler server pool uses its outgoing call and poolSize origin`() {
        val changed =
            graph.copy(
                services =
                    listOf(
                        graph.services.first().copy(type = "pooler", pooler = PoolerSettings(4, 0.0)),
                        graph.services.last(),
                    ),
                calls = listOf(graph.calls.single().copy(pool = null)),
            )
        val warning = warnings(changed).single()

        assertThat(warning.path).isEqualTo("caller")
        assertThat(warning.pointer).isEqualTo("/blocks/caller/params/poolSize")
        assertThat(warning.args)
            .containsEntry("target", JsonPrimitive("caller"))
            .containsEntry("demand", JsonPrimitive("4"))
            .containsEntry("holdingMs", JsonPrimitive("40"))
            .doesNotContainKey("reason")
        assertThat(warnings(changed.copy(calls = listOf(changed.calls.single().copy(timeoutMs = 20.0))))).isEmpty()
    }

    @Test
    fun `compiled replicas have separate pools and replica overrides set the parallelism qualification`() {
        val compiled = compile(model(3, """, "replicaOverrides":{"2":{"handlers":1}}"""))
        val warnings = ModelLinter().lint(compiled).filter { it.code == "LINT_POOL_DEMAND" }

        assertThat(warnings).hasSize(3)
        assertThat(warnings.map { it.path }).containsExactlyInAnyOrder("caller-db#1", "caller-db#2", "caller-db#3")
        warnings.forEach { warning ->
            assertThat(warning.args).containsEntry("demand", JsonPrimitive("2"))
            assertThat(warning.message).contains("caller#${warning.args!!.getValue("replica")}")
        }
        assertThat(warnings.single { it.path == "caller-db#2" }.args).doesNotContainKey("reason")
        assertThat(warnings.single { it.path == "caller-db#1" }.args).containsEntry("reason", JsonPrimitive("limitsHandlers"))
    }

    @Test
    fun `variant and grid pool sizes locate overrides and affected points`() {
        val fixtures = ReplicaGroupsTest()
        val varied =
            fixtures.experiment().copy(
                variants =
                    listOf(
                        Variant("roomy", overrides = mapOf("caller-db.pool.size" to JsonPrimitive(8))),
                        Variant("tight", overrides = mapOf("caller-db.pool.size" to JsonPrimitive(2))),
                    ),
            )
        val warning = ModelLinter().lint(compile(model(), varied)).single { it.code == "LINT_POOL_DEMAND" }
        assertThat(warning.variant).isEqualTo("tight")
        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/1/overrides/caller-db.pool.size")

        val grid = fixtures.experiment().copy(grid = listOf(GridAxis("caller-db.pool.size", listOf(JsonPrimitive(2), JsonPrimitive(8)))))
        val gridWarning = ModelLinter().lint(compile(model(), grid)).single { it.code == "LINT_POOL_DEMAND" }
        assertThat(gridWarning.variant).isEqualTo("baseline")
        assertThat(gridWarning.pointer).isEqualTo("/grid/0/values/0")
        assertThat(gridWarning.args).containsEntry("points", JsonPrimitive("p0"))
    }

    @Test
    fun `identical findings group across variants and grid points`() {
        val variants =
            listOf("one", "two").map {
                CompiledVariant(it, it, listOf(CompiledPoint("p0", emptyMap(), graph), CompiledPoint("p1", emptyMap(), graph)))
            }
        val warning = ModelLinter().lint(CompiledExperiment(variants, run)).single { it.code == "LINT_POOL_DEMAND" }
        assertThat(warning.variant).isNull()
        assertThat(warning.args).doesNotContainKey("points")
    }

    @Test
    fun `configurable threshold includes equality and rejects nonfinite or nonpositive values`() {
        assertThat(ModelLinter(poolDemandThreshold = 1.01).lint(experiment(graph)).filter { it.code == "LINT_POOL_DEMAND" }).isEmpty()
        val warning =
            ModelLinter(poolDemandThreshold = 0.5).lint(experiment(withRate(0.05))).single { it.code == "LINT_POOL_DEMAND" }
        assertThat(warning.args).containsEntry("threshold", JsonPrimitive("0.5")).containsEntry("demand", JsonPrimitive("2"))
        listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).forEach { threshold ->
            assertThatThrownBy { ModelLinter(poolDemandThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `upstream retries do not multiply nominal demand of a downstream pool`() {
        val changed =
            graph.copy(
                services = graph.services + service("tail", 30.0),
                calls =
                    listOf(
                        graph.calls.single().copy(pool = null, attempts = 10),
                        call("db-tail", "db", "tail").copy(network = fixed(5.0)),
                    ),
            )
        assertThat(warnings(changed).single().args)
            .containsEntry("target", JsonPrimitive("db-tail"))
            .containsEntry("demand", JsonPrimitive("4"))
            .containsEntry("ratePerSecond", JsonPrimitive("100"))
    }

    @Test
    fun `target replica processing override changes the shared callers pool holding`() {
        val fixtures = ReplicaGroupsTest()

        fun pooled(overrides: String) =
            fixtures.model(3, overrides = overrides).let { model ->
                model.copy(
                    connections =
                        model.connections.map { connection ->
                            if (connection.type != "call") {
                                connection
                            } else {
                                connection.copy(
                                    params =
                                        JsonObject(
                                            connection.params +
                                                mapOf(
                                                    "network" to
                                                        JsonObject(mapOf("kind" to JsonPrimitive("fixed"), "mean" to JsonPrimitive("0ms"))),
                                                ) +
                                                if (connection.id == "gateway-to-worker") {
                                                    mapOf(
                                                        "pool" to JsonObject(mapOf("size" to JsonPrimitive(1))),
                                                        "timeout" to JsonPrimitive("1s"),
                                                    )
                                                } else {
                                                    emptyMap()
                                                },
                                        ),
                                )
                            }
                        },
                )
            }
        assertThat(ModelLinter().lint(compile(pooled(""))).filter { it.code == "LINT_POOL_DEMAND" }).isEmpty()
        val warning =
            ModelLinter()
                .lint(compile(pooled(""", "replicaOverrides":{"2":{"processing":{"mean":"100ms"}}}""")))
                .single { it.code == "LINT_POOL_DEMAND" }
        assertThat(warning.args)
            .containsEntry("holdingMs", JsonPrimitive("203"))
            .containsEntry("demand", JsonPrimitive("2.03"))
    }

    @Test
    fun `pooler variants and grid point to poolSize overrides`() {
        val fixtures = ReplicaGroupsTest()
        val source =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":7,"blocks":{
                  "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"150/s"}]},"deadline":"10s"}},
                  "front":{"type":"service","params":{"handlers":100,"processing":{"kind":"fixed","mean":"0ms"}}},
                  "caller":{"type":"pooler","params":{"maxClientConnections":100,"poolSize":2,"waitTimeout":"1s"}},
                  "db":{"type":"database","params":{"maxConnections":100,"processing":{"kind":"fixed","mean":"40ms"}}}
                },"connections":[
                  {"id":"request","type":"request","from":"client","to":"front"},
                  {"id":"front-caller","type":"call","from":"front","to":"caller","params":{"timeout":"1s"}},
                  {"id":"caller-db","type":"call","from":"caller","to":"db","params":{"timeout":"1s","network":{"kind":"fixed","mean":"0ms"}}}
                ]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val varied =
            fixtures.experiment().copy(
                variants =
                    listOf(
                        Variant("roomy", overrides = mapOf("caller.poolSize" to JsonPrimitive(8))),
                        Variant("tight", overrides = mapOf("caller.poolSize" to JsonPrimitive(2))),
                    ),
            )
        val warning = ModelLinter().lint(compile(source, varied)).single { it.code == "LINT_POOL_DEMAND" }
        assertThat(warning.variant).isEqualTo("tight")
        assertThat(warning.pointer).isEqualTo("/variants/1/overrides/caller.poolSize")
        val grid = fixtures.experiment().copy(grid = listOf(GridAxis("caller.poolSize", listOf(JsonPrimitive(2), JsonPrimitive(8)))))
        val gridWarning = ModelLinter().lint(compile(source, grid)).single { it.code == "LINT_POOL_DEMAND" }
        assertThat(gridWarning.pointer).isEqualTo("/grid/0/values/0")
        assertThat(gridWarning.args).containsEntry("points", JsonPrimitive("p0"))
    }

    private fun model(
        replicas: Int = 1,
        overrides: String = "",
    ) = (
        DocumentCodec.decodeModel(
            """{"schemaVersion":7,"blocks":{
              "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"150/s"}]},"deadline":"10s"}},
              "caller":{"type":"service","params":{"replicas":$replicas,"handlers":8,"processing":{"kind":"fixed","mean":"0ms"}}$overrides},
              "db":{"type":"database","params":{"maxConnections":100,"processing":{"kind":"fixed","mean":"40ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"caller"},
              {"id":"caller-db","type":"call","from":"caller","to":"db","params":{"timeout":"1s","network":{"kind":"fixed","mean":"0ms"},"pool":{"size":2}}}
            ]}""",
            "m.model.json",
        ) as DecodeResult.Ok
    ).value

    private fun compile(
        model: resiliencelab.core.document.ModelFile,
        experiment: resiliencelab.core.document.ExperimentFile = ReplicaGroupsTest().experiment(),
    ): CompiledExperiment =
        ReplicaGroupsTest().compile(model, experiment).let {
            assertThat(it.diagnostics).isEmpty()
            requireNotNull(it.experiment)
        }

    private fun experiment(graph: GraphIr) =
        CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run)

    private fun warnings(graph: GraphIr): List<Diagnostic> = ModelLinter().lint(experiment(graph)).filter { it.code == "LINT_POOL_DEMAND" }

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
    ) = ServiceNode(path, 8, 0, fixed(meanMs), 0.0, Origin("m.model.json", "/blocks/$path"))

    private fun call(
        path: String,
        from: String,
        to: String,
    ) = CallEdge(
        path,
        from,
        to,
        fixed(10.0),
        1_000.0,
        1,
        Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0),
        Origin("m.model.json", "/connections/$path"),
        pool = CallPool(4),
    )
}
