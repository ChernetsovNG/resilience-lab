package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ModelFile
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class PoolerCompilerTest {
    @Test
    fun `transaction pooler compiles between a service and its downstream target`() {
        val result = PoolerTestModel.compile()
        assertThat(result.diagnostics).isEmpty()
        val graph =
            requireNotNull(result.experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(graph.services.map { it.path }).containsExactly("gateway", "pooler", "db")
        assertThat(graph.calls.map { it.path }).containsExactly("to-pooler", "to-db")
        assertThat(graph.calls.last().attempts).isEqualTo(1)
    }

    @Test
    fun `pooler artifacts are identical across workers and document order`(
        @TempDir root: Path,
    ) {
        fun run(
            source: ModelFile,
            workers: Int,
        ): Map<String, ByteArray> {
            val directory = Files.createDirectories(root.resolve("workers-$workers"))
            Files.writeString(directory.resolve("m.model.json"), DocumentCodec.encodeModel(source))
            Files.writeString(directory.resolve("e.experiment.json"), DocumentCodec.encodeExperiment(PoolerTestModel.experiment))
            val outcome =
                ExperimentExecutor(workers).use { executor ->
                    Lab(FileWorkspace(directory), executor = executor).use { lab -> lab.run("e.experiment.json", "run") }
                }
            val artifact = directory.resolve(outcome.runDirectory)
            return Files.walk(artifact).use { files ->
                files.filter(Files::isRegularFile).toList().associate {
                    artifact.relativize(it).toString() to Files.readAllBytes(it)
                }
            }
        }
        val model = PoolerTestModel.withServicePool()
        val expected = run(model, 1)
        val shuffled =
            model.copy(
                blocks =
                    model.blocks.entries
                        .reversed()
                        .associate { it.toPair() },
                connections = model.connections.reversed(),
            )
        for (workers in listOf(2, 4, 8)) {
            val actual = run(shuffled, workers)
            assertThat(actual.keys).containsExactlyInAnyOrderElementsOf(expected.keys)
            expected.forEach { (path, bytes) -> assertThat(actual.getValue(path)).describedAs("$workers/$path").isEqualTo(bytes) }
        }
    }

    @Test
    fun `adding a pooler preserves stream addresses of existing elements`() {
        val model = PoolerTestModel.model
        val without =
            model.copy(
                blocks = model.blocks - "pooler",
                connections =
                    model.connections
                        .filter { it.id != "to-pooler" }
                        .map { if (it.id == "to-db") it.copy(from = "gateway") else it },
            )

        fun keys(source: ModelFile) =
            PathStreams.keys(
                requireNotNull(PoolerTestModel.compile(source).experiment)
                    .variants
                    .single()
                    .points
                    .single()
                    .graph,
                0,
            )
        val before = keys(without).associateWith(PathStreams::addressOf)
        val after = keys(model).associateWith(PathStreams::addressOf)
        assertThat(after).containsAllEntriesOf(before)
        assertThat(after.keys.filter { it.path == listOf("pooler") }.map { it.role }).containsExactly("processing")
    }

    @Test
    fun `pooler contributes upstream holding time without a service handler diagnostic`() {
        val model = PoolerTestModel.model
        val client = model.blocks.getValue("client")
        val gateway = model.blocks.getValue("gateway")
        val source =
            model.copy(
                blocks =
                    model.blocks +
                        mapOf(
                            "client" to
                                client.copy(
                                    params =
                                        JsonObject(
                                            client.params +
                                                (
                                                    "load" to
                                                        kotlinx.serialization.json.Json.parseToJsonElement(
                                                            """{"points":[{"time":"0ms","rate":"1000/s"}]}""",
                                                        )
                                                ),
                                        ),
                                ),
                            "gateway" to gateway.copy(params = JsonObject(gateway.params + ("handlers" to JsonPrimitive(1)))),
                        ),
            )
        val diagnostics =
            ModelLinter()
                .lint(requireNotNull(PoolerTestModel.compile(source).experiment))
                .filter { it.code == "LINT_HANDLERS_LITTLE" }
        assertThat(diagnostics.map { it.path }).doesNotContain("pooler")
        assertThat(diagnostics).anySatisfy {
            assertThat(it.path).isEqualTo("gateway")
            assertThat(it.pointer).isEqualTo("/blocks/gateway/params/handlers")
            assertThat(it.args).containsEntry("holdingMs", JsonPrimitive(10.0))
        }
    }

    @Test
    fun `pool on the outgoing pooler call is rejected at that parameter`() {
        val model = PoolerTestModel.model
        val source =
            model.copy(
                connections =
                    model.connections.map { edge ->
                        if (edge.id == "to-db") {
                            edge.copy(
                                params =
                                    JsonObject(
                                        edge.params + (
                                            "pool" to
                                                kotlinx.serialization.json.Json
                                                    .parseToJsonElement("""{"size":1,"acquireTimeout":"5ms"}""")
                                        ),
                                    ),
                            )
                        } else {
                            edge
                        }
                    },
            )
        val result = PoolerTestModel.compile(source)
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.code).isEqualTo("POOLER_CALL_POOL")
            assertThat(it.pointer).isEqualTo("/connections/2/params/pool")
            assertThat(it.path).isEqualTo("to-db")
            assertThat(it.args).containsEntry("pooler", JsonPrimitive("pooler"))
        }
    }

    @Test
    fun `forbidden outgoing pool keeps the source of whole and nested variant overrides`() {
        for ((path, value) in listOf(
            "to-db.pool" to JsonObject(mapOf("size" to JsonPrimitive(1))),
            "to-db.pool.size" to JsonPrimitive(1),
        )) {
            val experiment =
                PoolerTestModel.experiment.copy(
                    variants =
                        listOf(
                            PoolerTestModel.experiment.variants
                                .single()
                                .copy(overrides = mapOf(path to value)),
                        ),
                )
            val result = ModelCompiler().compile(PoolerTestModel.model, "m.model.json", experiment, "e.experiment.json")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics).anySatisfy {
                assertThat(it.code).isEqualTo("POOLER_CALL_POOL")
                assertThat(it.document).isEqualTo("e.experiment.json")
                assertThat(it.pointer).isEqualTo("/variants/0/overrides/$path")
                assertThat(it.variant).isEqualTo("baseline")
                assertThat(it.path).isEqualTo("to-db")
            }
        }
    }

    @Test
    fun `forbidden outgoing pool keeps grid origin ahead of a variant object origin`() {
        for (overrides in listOf(emptyMap(), mapOf("to-db.pool" to JsonObject(mapOf("size" to JsonPrimitive(2)))))) {
            val experiment =
                PoolerTestModel.experiment.copy(
                    variants =
                        listOf(
                            PoolerTestModel.experiment.variants
                                .single()
                                .copy(overrides = overrides),
                        ),
                    grid = listOf(resiliencelab.core.document.GridAxis("to-db.pool.size", listOf(JsonPrimitive(1)))),
                )
            val result = ModelCompiler().compile(PoolerTestModel.model, "m.model.json", experiment, "e.experiment.json")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics).anySatisfy {
                assertThat(it.code).isEqualTo("POOLER_CALL_POOL")
                assertThat(it.document).isEqualTo("e.experiment.json")
                assertThat(it.pointer).isEqualTo("/grid/0/values/0")
                assertThat(it.variant).isEqualTo("baseline")
                assertThat(it.path).isEqualTo("to-db")
            }
        }
    }

    @Test
    fun `pooler needs exactly one outgoing call with a located diagnostic`() {
        val model = PoolerTestModel.model
        for (connections in listOf(model.connections.dropLast(1), model.connections + model.connections.last().copy(id = "second"))) {
            val result = PoolerTestModel.compile(model.copy(connections = connections))
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics).anySatisfy {
                assertThat(it.code).isEqualTo("POOLER_OUTPUT")
                assertThat(it.pointer).isEqualTo("/blocks/pooler")
                assertThat(it.args).containsEntry("pooler", JsonPrimitive("pooler"))
            }
        }
    }

    @Test
    fun `invalid pool capacities and wait duration point to the parameter`() {
        val model = PoolerTestModel.model
        val pooler = model.blocks.getValue("pooler")
        for ((name, value) in listOf(
            "maxClientConnections" to JsonPrimitive(0),
            "poolSize" to JsonPrimitive(0),
            "waitTimeout" to JsonPrimitive("-1ms"),
        )) {
            val result =
                PoolerTestModel.compile(
                    model.copy(
                        blocks =
                            model.blocks + ("pooler" to pooler.copy(params = JsonObject(pooler.params + (name to value)))),
                    ),
                )
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains("/blocks/pooler/params/$name")
        }
    }
}

internal object PoolerTestModel {
    val model =
        (
            DocumentCodec.decodeModel(
                """{"schemaVersion":5,"blocks":{
              "client":{"type":"client","params":{"load":{"points":[{"time":"0ms","rate":"100/s"}]},"deadline":"1s"}},
              "gateway":{"type":"service","params":{"handlers":100,"processing":{"kind":"fixed","mean":"0ms"}}},
              "pooler":{"type":"pooler","params":{"maxClientConnections":2,"poolSize":1,"waitTimeout":"5ms","processing":{"kind":"fixed","mean":"1ms"}}},
              "db":{"type":"database","params":{"maxConnections":100,"processing":{"kind":"fixed","mean":"9ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"gateway"},
              {"id":"to-pooler","type":"call","from":"gateway","to":"pooler","params":{"timeout":"100ms"}},
              {"id":"to-db","type":"call","from":"pooler","to":"db","params":{"timeout":"100ms"}}
            ]}""",
                "m.model.json",
            ) as DecodeResult.Ok
        ).value
    val experiment =
        (
            DocumentCodec.decodeExperiment(
                """{"schemaVersion":2,"modelRef":"m.model.json","execution":{"replications":5,"warmup":"0ms","measurement":"100ms","window":"10ms","seed":42},"variants":[{"id":"baseline"}]}""",
                "e.experiment.json",
            ) as DecodeResult.Ok
        ).value

    fun withServicePool(): ModelFile =
        model.copy(
            connections =
                model.connections.map { edge ->
                    if (edge.id == "to-pooler") {
                        edge.copy(
                            params =
                                JsonObject(
                                    edge.params + (
                                        "pool" to
                                            kotlinx.serialization.json.Json
                                                .parseToJsonElement("""{"size":2,"acquireTimeout":"50ms"}""")
                                    ),
                                ),
                        )
                    } else {
                        edge
                    }
                },
        )

    fun compile(source: ModelFile = model): CompileResult = ModelCompiler().compile(source, "m.model.json", experiment, "e.experiment.json")
}
