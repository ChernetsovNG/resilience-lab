package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.ScenarioStep
import resiliencelab.core.engine.ksl.AttemptOutcome
import resiliencelab.core.engine.ksl.PathStreamSource
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.ReliabilityModel
import resiliencelab.core.engine.ksl.StreamPlan
import resiliencelab.core.execution.CostEstimator
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.lab.Lab
import resiliencelab.core.results.NodeWindow
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class DatabaseBlockTest {
    private val model =
        (
            DocumentCodec.decodeModel(
                """{"schemaVersion":5,"blocks":{
              "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"10/s"}]},"deadline":"1s"}},
              "gateway":{"type":"service","params":{"handlers":100,"processing":{"kind":"fixed","mean":"0ms"}}},
              "db":{"type":"database","params":{"maxConnections":1,"queue":1,"processing":{"kind":"fixed","mean":"10ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"gateway"},
              {"id":"query","type":"call","from":"gateway","to":"db","params":{"timeout":"100ms"}}
            ]}""",
                "m.model.json",
            ) as DecodeResult.Ok
        ).value
    private val experiment =
        (
            DocumentCodec.decodeExperiment(
                """{"schemaVersion":2,"modelRef":"m.model.json","execution":{"replications":5,"warmup":"0ms","measurement":"100ms","seed":42},"variants":[{"id":"baseline"}]}""",
                "e.experiment.json",
            ) as DecodeResult.Ok
        ).value

    @Test
    fun `database uses connection slots with FIFO queue and full queue rejection`() {
        val rig = simulate(graph(), listOf(0.0, 1.0, 2.0))
        assertThat(rig.invocations.map { it.outcome }).containsExactly(
            AttemptOutcome.SUCCEEDED,
            AttemptOutcome.SUCCEEDED,
            AttemptOutcome.DOWNSTREAM_FAILURE,
        )
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 20.0, 2.0)
        val totals =
            rig.reliability.metrics
                .replicationResult()
                .services
                .getValue("db")
        assertThat(totals.offeredAttempts).isEqualTo(3)
        assertThat(totals.admittedAttempts).isEqualTo(2)
        assertThat(totals.slotPools.getValue("handlers").queueFullCount).isEqualTo(1)
        assertThat(totals.slotPools.getValue("handlers").capacityIntegralMs).isEqualTo(graph().run.measurementMs)
        assertThat(totals.slotPools.getValue("handlers").busyIntegralMs).isEqualTo(20.0)
        assertThat(totals.slotPools.getValue("handlers").queueIntegralMs).isEqualTo(9.0)
        val windows = rig.windows.filter { it.id == "db" }.map { it.metrics }
        assertThat(windows.sumOf { it.successes }).isEqualTo(2)
        assertThat(windows.sumOf { it.slotPools.getValue("handlers").queueFullCount }).isEqualTo(1)
        assertThat(windows.sumOf { it.slotPools.getValue("handlers").busyIntegralMs }).isEqualTo(20.0)
        assertThat(windows.sumOf { it.slotPools.getValue("handlers").queueIntegralMs }).isEqualTo(9.0)
        assertThat(windows.sumOf { it.latency.count }).isEqualTo(2)
        assertThat(windows.sumOf { it.latency.sumMs }).isEqualTo(29.0)
    }

    @Test
    fun `pooled database call preserves the client load profile and waits before offering queries`() {
        val load =
            Json.parseToJsonElement(
                """{"points":[{"time":"0ms","rate":"10/s"},{"time":"100ms","rate":"30/s"}]}""",
            )
        val pool = Json.parseToJsonElement("""{"size":1,"acquireTimeout":"50ms"}""")
        val client = model.blocks.getValue("client")
        val params = JsonObject(client.params + ("load" to load))
        val source =
            model.copy(
                blocks = model.blocks + ("client" to client.copy(params = params)),
                connections =
                    model.connections.map { connection ->
                        if (connection.type == "call") {
                            connection.copy(params = JsonObject(connection.params + ("pool" to pool)))
                        } else {
                            connection
                        }
                    },
            )
        val compiled = graph(source)
        assertThat(compiled.client.load.rateAt(50.0)).isEqualTo(0.02)
        val rig = simulate(compiled, listOf(0.0, 1.0, 2.0))
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 20.0, 30.0)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(
            result.services
                .getValue("db")
                .slotPools
                .getValue("handlers")
                .queueIntegralMs,
        ).isZero()
        assertThat(
            result.connections
                .getValue("query")
                .slotPools
                .getValue("pool")
                .busyIntegralMs,
        ).isEqualTo(30.0)
        assertThat(
            result.connections
                .getValue("query")
                .slotPools
                .getValue("pool")
                .queueIntegralMs,
        ).isEqualTo(27.0)
        assertThat(
            result.connections
                .getValue("query")
                .slotPools
                .getValue("pool")
                .waitCount,
        ).isEqualTo(2)
    }

    @Test
    fun `zero queue rejects immediately and multiple connections run concurrently`() {
        val noQueue = databaseParams("queue" to JsonPrimitive(0))
        val rig = simulate(graph(noQueue), listOf(0.0, 1.0))
        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 1.0)
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .services
                .getValue("db")
                .slotPools
                .getValue("handlers")
                .queueFullCount,
        ).isEqualTo(1)
        val parallel = simulate(graph(databaseParams("maxConnections" to JsonPrimitive(2))), listOf(0.0, 1.0))
        assertThat(parallel.invocations.map { it.outcome }).containsOnly(AttemptOutcome.SUCCEEDED)
        assertThat(parallel.invocations.map { it.work.processCompletionTime }).containsExactly(10.0, 11.0)
    }

    @Test
    fun `query errors use failure probability and normal call retry semantics`() {
        val source = databaseParams("failureRate" to JsonPrimitive("100%"))
        val withRetry =
            source.copy(
                connections =
                    source.connections.map {
                        if (it.id == "query") it.copy(params = JsonObject(it.params + ("attempts" to JsonPrimitive(2)))) else it
                    },
            )
        val rig = simulate(graph(withRetry), listOf(0.0))
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.DOWNSTREAM_FAILURE)
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(20.0)
        val totals = rig.reliability.metrics.replicationResult()
        assertThat(totals.services.getValue("db").failures).isEqualTo(2)
        assertThat(totals.connections.getValue("query").retries).isEqualTo(1)
        assertThat(rig.windows.filter { it.id == "db" }.sumOf { it.metrics.failures }).isEqualTo(2)
    }

    @Test
    fun `fractional database error probability is reproducible`() {
        val source =
            databaseParams(
                "failureRate" to JsonPrimitive("25%"),
                "maxConnections" to JsonPrimitive(100),
                "processing" to JsonObject(mapOf("kind" to JsonPrimitive("fixed"), "mean" to JsonPrimitive("0ms"))),
            )
        val arrivals = List(2_000) { it / 25.0 }
        val first = simulate(graph(source), arrivals).reliability.metrics.replicationResult()
        val second = simulate(graph(source), arrivals).reliability.metrics.replicationResult()
        assertThat(first).isEqualTo(second)
        assertThat(first.services.getValue("db").failures).isBetween(440, 560)
        assertThat(first.services.getValue("db").admittedAttempts).isEqualTo(2_000)
    }

    @Test
    fun `router can route calls to two databases and both are estimated and measured`() {
        val source = routed()
        val compiled = compile(source)
        assertThat(compiled.diagnostics).isEmpty()
        val experiment = requireNotNull(compiled.experiment)
        assertThat(ModelLinter().lint(experiment)).isEmpty()
        assertThat(CostEstimator.estimate(experiment, 1).expectedEvents).isPositive()
        val rig = simulate(graph(source), listOf(0.0, 1.0, 2.0, 3.0))
        assertThat(rig.invocations.map { it.outcome }).containsOnly(AttemptOutcome.SUCCEEDED)
        val totals = rig.reliability.metrics.replicationResult()
        assertThat(totals.services.getValue("db").offeredAttempts).isEqualTo(2)
        assertThat(totals.services.getValue("db2").offeredAttempts).isEqualTo(2)
        assertThat(totals.connections.getValue("route-db").sentAttempts).isEqualTo(2)
        assertThat(totals.connections.getValue("route-db2").sentAttempts).isEqualTo(2)
    }

    @Test
    fun `database cannot have outgoing calls or a service scenario`() {
        val outgoing = model.connections[1].copy(id = "outgoing", from = "db", to = "gateway")
        val invalid = compile(model.copy(connections = model.connections + outgoing))
        assertThat(invalid.experiment).isNull()
        assertThat(invalid.diagnostics).anySatisfy {
            assertThat(it.code).isEqualTo("CONNECTION_TYPE")
            assertThat(it.pointer).isEqualTo("/connections/2/type")
        }
        val scenario = model.blocks.getValue("db").copy(scenario = listOf(ScenarioStep("process")))
        assertThat(compile(model.copy(blocks = model.blocks + ("db" to scenario))).diagnostics).anySatisfy {
            assertThat(it.code).isEqualTo("SCENARIO_BLOCK")
            assertThat(it.pointer).isEqualTo("/blocks/db/scenario")
        }
    }

    @Test
    fun `database parameters are validated with parameter pointers`() {
        for ((name, value) in listOf(
            "maxConnections" to JsonPrimitive(0),
            "maxConnections" to JsonPrimitive(1.5),
            "queue" to JsonPrimitive(-1),
            "failureRate" to JsonPrimitive("101%"),
            "processing" to JsonObject(mapOf("kind" to JsonPrimitive("fixed"), "mean" to JsonPrimitive("-1ms"))),
            "replicas" to JsonPrimitive(2),
        )) {
            val result = compile(databaseParams(name to value))
            assertThat(result.experiment).describedAs(name).isNull()
            assertThat(result.diagnostics.map { it.pointer }).anyMatch { it?.startsWith("/blocks/db/params/$name") == true }
        }
    }

    @Test
    fun `adding a database preserves existing random streams`() {
        val base = graph(model.copy(blocks = model.blocks - "db", connections = model.connections.take(1)))
        val extended = graph()
        val keys = PathStreams.keys(base, 0)
        val before = StreamPlan(keys)
        val after = StreamPlan(PathStreams.keys(extended, 0))
        keys.forEach { key -> assertThat(after.address(key)).isEqualTo(before.address(key)) }
        assertThat(PathStreams.keys(extended, 0).filter { it.path == listOf("db") }.map { it.role })
            .containsExactlyInAnyOrder("processing", "outcome")
    }

    @Test
    fun `database artifact bytes match across workers and reversed documents`(
        @TempDir root: Path,
    ) {
        val source = routed()

        fun run(
            source: ModelFile,
            name: String,
            workers: Int,
        ): Map<String, ByteArray> {
            val directory = Files.createDirectories(root.resolve(name))
            Files.writeString(directory.resolve("m.model.json"), DocumentCodec.encodeModel(source))
            Files.writeString(directory.resolve("e.experiment.json"), DocumentCodec.encodeExperiment(experiment))
            val outcome =
                ExperimentExecutor(workers).use { executor ->
                    Lab(FileWorkspace(directory), executor = executor).use { it.run("e.experiment.json", "run") }
                }
            val artifact = directory.resolve(outcome.runDirectory)
            return Files.walk(artifact).use { paths ->
                paths.filter(Files::isRegularFile).toList().associate { artifact.relativize(it).toString() to Files.readAllBytes(it) }
            }
        }
        val expected = run(source, "reference", 1)
        val reversed =
            source.copy(
                blocks =
                    source.blocks.entries
                        .reversed()
                        .associate { it.toPair() },
                connections = source.connections.reversed(),
            )
        for (workers in listOf(2, 4, 8)) {
            val actual = run(reversed, "workers-$workers", workers)
            assertThat(actual.keys).containsExactlyInAnyOrderElementsOf(expected.keys)
            expected.forEach { (path, bytes) -> assertThat(actual.getValue(path)).describedAs("$workers/$path").isEqualTo(bytes) }
        }
    }

    private fun databaseParams(vararg params: Pair<String, kotlinx.serialization.json.JsonElement>): ModelFile {
        val database = model.blocks.getValue("db")
        return model.copy(blocks = model.blocks + ("db" to database.copy(params = JsonObject(database.params + params))))
    }

    private fun routed(): ModelFile =
        model.copy(
            blocks =
                model.blocks +
                    mapOf(
                        "router" to model.blocks.getValue("gateway").copy(type = "router", params = JsonObject(emptyMap())),
                        "db2" to model.blocks.getValue("db"),
                    ),
            connections =
                model.connections.map { if (it.id == "query") it.copy(to = "router") else it } +
                    listOf(
                        model.connections[1].copy(id = "route-db", type = "route", from = "router", params = JsonObject(emptyMap())),
                        model.connections[1].copy(
                            id = "route-db2",
                            type = "route",
                            from = "router",
                            to = "db2",
                            params = JsonObject(emptyMap()),
                        ),
                    ),
        )

    private fun compile(source: ModelFile) = ModelCompiler().compile(source, "m.model.json", experiment, "e.experiment.json")

    private fun graph(source: ModelFile = model): GraphIr {
        val result = compile(source)
        assertThat(result.diagnostics).isEmpty()
        return requireNotNull(result.experiment)
            .variants
            .single()
            .points
            .single()
            .graph
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double>,
    ): Rig {
        val simulation = Model("DatabaseBlockTest", autoCSVReports = false)
        val windows = mutableListOf<NodeWindow>()
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(simulation, graph, streams, onWindow = { _, rows, _ -> windows += rows })
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(simulation, name = "database-driver") {
            override fun initialize() {
                arrivals.forEach { invocations += reliability.invoke(graph.entry, it, originalRequest = true) }
            }
        }
        simulation.numberOfReplications = 1
        simulation.lengthOfReplication = 200.0
        simulation.simulate()
        return Rig(reliability, invocations, windows)
    }

    private data class Rig(
        val reliability: ReliabilityModel,
        val invocations: List<ReliabilityModel.ServiceInvocation>,
        val windows: List<NodeWindow>,
    )
}
