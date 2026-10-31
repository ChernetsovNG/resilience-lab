package resiliencelab.core.compiler

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
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class RouterCompilerTest {
    @Test
    fun `document scenario retries another router output and continues through repeated and direct calls`() {
        val gateway = model.blocks.getValue("gateway")
        val left = model.blocks.getValue("left")
        val router = model.blocks.getValue("router")
        val call = model.connections[1]

        fun process(mean: String) =
            ScenarioStep(
                "process",
                processing = JsonObject(mapOf("kind" to JsonPrimitive("fixed"), "mean" to JsonPrimitive(mean))),
                failureRate = "0%",
            )
        val source =
            model.copy(
                blocks =
                    model.blocks +
                        mapOf(
                            "gateway" to
                                gateway.copy(
                                    scenario =
                                        listOf(
                                            process("4ms"),
                                            ScenarioStep("call", connection = "call"),
                                            ScenarioStep("process"),
                                            ScenarioStep("call", connection = "call"),
                                            process("3ms"),
                                            ScenarioStep("call", connection = "direct"),
                                        ),
                                ),
                            "left" to left.copy(params = JsonObject(left.params + ("failureRate" to JsonPrimitive("100%")))),
                            "router" to router.copy(params = JsonObject(mapOf("policy" to JsonPrimitive("leastInFlight")))),
                            "tail" to left.copy(params = JsonObject(left.params + ("processing" to process("5ms").processing!!))),
                        ),
                connections =
                    model.connections.map {
                        if (it.id ==
                            "call"
                        ) {
                            it.copy(params = JsonObject(it.params + ("attempts" to JsonPrimitive(2))))
                        } else {
                            it
                        }
                    } +
                        call.copy(id = "direct", to = "tail", params = JsonObject(mapOf("timeout" to JsonPrimitive("100ms")))),
            )
        val compiled = compile(source)
        assertThat(compiled.diagnostics).isEmpty()
        val graph =
            requireNotNull(compiled.experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        val simulation = Model("ScenarioRouterIntegration", autoCSVReports = false)
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(simulation, graph, streams)
        lateinit var invocation: ReliabilityModel.ServiceInvocation
        object : ProcessModel(simulation, name = "scenario-router-driver") {
            override fun initialize() {
                invocation = reliability.invoke(graph.entry, originalRequest = true)
            }
        }
        simulation.numberOfReplications = 1
        simulation.lengthOfReplication = 1_100.0
        simulation.simulate()
        assertThat(invocation.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        // 4 local + (2 failed + 3 successful) + 1 inherited + (2 + 3) + 3 local + 5 direct = 23 ms.
        assertThat(invocation.work.processCompletionTime).isEqualTo(23.0)
        val result = reliability.metrics.replicationResult()
        assertThat(result.successes).isEqualTo(1)
        assertThat(result.connections.getValue("call").sentAttempts).isEqualTo(4)
        assertThat(result.connections.getValue("call").retries).isEqualTo(2)
        assertThat(result.connections.getValue("to-left").sentAttempts).isEqualTo(2)
        assertThat(result.connections.getValue("to-right").sentAttempts).isEqualTo(2)
        assertThat(result.connections.getValue("direct").sentAttempts).isEqualTo(1)
        assertThat(result.connections.getValue("direct").retries).isZero()
        assertThat(result.services.getValue("gateway").admittedAttempts).isEqualTo(1)
        reliability.metrics.verifyConnectionsDrained()
    }

    @Test
    fun `document permutations preserve routed artifact bytes including manifest`(
        @TempDir root: Path,
    ) {
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
        val gateway = model.blocks.getValue("gateway")
        val left = model.blocks.getValue("left")
        val routedScenario =
            model.copy(
                blocks =
                    model.blocks +
                        mapOf(
                            "gateway" to
                                gateway.copy(
                                    scenario =
                                        listOf(
                                            ScenarioStep(
                                                "process",
                                                processing =
                                                    JsonObject(
                                                        mapOf(
                                                            "kind" to JsonPrimitive("exponential"),
                                                            "mean" to JsonPrimitive("2ms"),
                                                        ),
                                                    ),
                                            ),
                                            ScenarioStep("call", connection = "call"),
                                            ScenarioStep("process"),
                                            ScenarioStep("call", connection = "call"),
                                        ),
                                ),
                            "left" to left.copy(params = JsonObject(left.params + ("failureRate" to JsonPrimitive("100%")))),
                        ),
                connections =
                    model.connections.map {
                        if (it.id ==
                            "call"
                        ) {
                            it.copy(params = JsonObject(it.params + ("attempts" to JsonPrimitive(2))))
                        } else {
                            it
                        }
                    },
            )
        val expected = run(routedScenario, "reference", 1)
        val shuffled =
            routedScenario.copy(
                blocks =
                    routedScenario.blocks.entries
                        .reversed()
                        .associate { it.toPair() },
                connections = routedScenario.connections.reversed(),
            )
        for (workers in listOf(2, 4, 8)) {
            val actual = run(shuffled, "workers-$workers", workers)
            assertThat(actual.keys).containsExactlyInAnyOrderElementsOf(expected.keys)
            expected.forEach { (path, bytes) -> assertThat(actual.getValue(path)).describedAs("$workers/$path").isEqualTo(bytes) }
        }
    }

    private val model =
        (
            DocumentCodec.decodeModel(
                """{"schemaVersion":6,"blocks":{
              "client":{"type":"client","params":{"load": {"points": [{"time": "0s", "rate": "10/s"}]},"deadline":"1s"}},
              "gateway":{"type":"service","params":{"handlers":2,"processing":{"kind":"fixed","mean":"1ms"}}},
              "router":{"type":"router","params":{"policy":"random"}},
              "left":{"type":"service","params":{"handlers":2,"processing":{"kind":"fixed","mean":"2ms"}}},
              "right":{"type":"service","params":{"handlers":2,"processing":{"kind":"fixed","mean":"3ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"gateway"},
              {"id":"call","type":"call","from":"gateway","to":"router","params":{"timeout":"10ms","retryTarget":"other"}},
              {"id":"to-left","type":"route","from":"router","to":"left","params":{"weight":3}},
              {"id":"to-right","type":"route","from":"router","to":"right"}
            ]}""",
                "m.model.json",
            ) as DecodeResult.Ok
        ).value
    private val experiment =
        (
            DocumentCodec.decodeExperiment(
                """{"schemaVersion":2,"modelRef":"m.model.json","execution":{"replications":5,"warmup":"0ms","measurement":"1s","seed":42},"variants":[{"id":"baseline"}]}""",
                "e.experiment.json",
            ) as DecodeResult.Ok
        ).value

    private fun compile(source: ModelFile = model) = ModelCompiler().compile(source, "m.model.json", experiment, "e.experiment.json")

    @Test
    fun `router with weighted outputs compiles and can be linted and estimated`() {
        val result = compile()
        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isNotNull()
        val compiled = requireNotNull(result.experiment)
        assertThat(ModelLinter().lint(compiled)).isEmpty()
        assertThat(
            resiliencelab.core.execution.CostEstimator
                .estimate(compiled, 1)
                .expectedEvents,
        ).isPositive()
    }

    @Test
    fun `router needs an output and diagnostic locates its block`() {
        val result = compile(model.copy(connections = model.connections.take(2)))
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.code).isEqualTo("ROUTER_OUTPUT")
            assertThat(it.pointer).isEqualTo("/blocks/router")
            assertThat(it.args).containsEntry("router", JsonPrimitive("router"))
        }
    }

    @Test
    fun `route cannot start at a service`() {
        val result = compile(model.copy(connections = model.connections.map { if (it.id == "to-left") it.copy(from = "gateway") else it }))
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.code).isEqualTo("CONNECTION_TYPE")
            assertThat(it.pointer).isEqualTo("/connections/2/type")
        }
    }

    @Test
    fun `router permits only one incoming connection`() {
        val call = model.connections[1]
        val result = compile(model.copy(connections = model.connections + call.copy(id = "second")))
        assertThat(result.diagnostics).anySatisfy { assertThat(it.code).isEqualTo("ROUTER_INPUT") }
    }

    @Test
    fun `nested routers are supported and cycles name their routes`() {
        val nested =
            model.copy(
                blocks = model.blocks + ("nested" to model.blocks.getValue("router")),
                connections =
                    model.connections.map { if (it.id == "to-left") it.copy(to = "nested") else it } +
                        model.connections[2].copy(id = "nested-left", from = "nested"),
            )
        assertThat(compile(nested).diagnostics).isEmpty()
        val cycle = nested.copy(connections = nested.connections.map { if (it.id == "nested-left") it.copy(to = "router") else it })
        assertThat(compile(cycle).diagnostics).anySatisfy {
            assertThat(it.code).isEqualTo("TOPOLOGY_GRAPH")
            assertThat(it.args).containsEntry("reason", JsonPrimitive("cycle"))
            assertThat(it.message).contains("router", "nested", "to-left", "nested-left")
        }
    }

    @Test
    fun `invalid policies retry targets and weights are rejected at their parameters`() {
        val badPolicy = model.blocks.getValue("router").copy(params = JsonObject(mapOf("policy" to JsonPrimitive("unknown"))))
        val badRetry = model.connections[1].let { it.copy(params = JsonObject(it.params + ("retryTarget" to JsonPrimitive("unknown")))) }
        val badWeight = model.connections[2].copy(params = JsonObject(mapOf("weight" to JsonPrimitive(0))))
        for ((source, pointer) in listOf(
            model.copy(blocks = model.blocks + ("router" to badPolicy)) to "/blocks/router/params/policy",
            model.copy(
                connections =
                    model.connections.map {
                        if (it.id ==
                            "call"
                        ) {
                            badRetry
                        } else {
                            it
                        }
                    },
            ) to "/connections/1/params/retryTarget",
            model.copy(connections = model.connections.map { if (it.id == "to-left") badWeight else it }) to "/connections/2/params/weight",
        )) {
            val result = compile(source)
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains(pointer)
        }
    }
}
