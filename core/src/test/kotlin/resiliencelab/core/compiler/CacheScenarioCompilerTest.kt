package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.catchThrowable
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.ir.ServiceStep
import resiliencelab.core.ir.connectionPaths
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path

class CacheScenarioCompilerTest {
    @Test
    fun poolerCannotCallACacheWithoutAKey() {
        val root = Json.parseToJsonElement(withScenario("""[{"type":"call","connection":"to-db"}]""")) as JsonObject
        val blocks = root["blocks"] as JsonObject
        val pooler = Json.parseToJsonElement("""{"type":"pooler","params":{"maxClientConnections":10,"poolSize":2,"waitTimeout":"1s"}}""")
        val connections =
            (root["connections"] as JsonArray).map {
                val edge = it as JsonObject
                if ((edge["id"] as JsonPrimitive).content == "to-redis") JsonObject(edge + ("from" to JsonPrimitive("db"))) else edge
            }
        val source =
            JsonObject(
                root +
                    mapOf(
                        "blocks" to JsonObject(blocks + ("db" to pooler)),
                        "connections" to JsonArray(connections),
                    ),
            ).toString()
        val result = compile(source)
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code }).contains("CACHE_CALL")
    }

    @Test
    fun unsupportedScenariosValidateButCannotEstimateOrRun(
        @TempDir directory: Path,
    ) {
        Files.writeString(directory.resolve("m.model.json"), modelText())
        Files.writeString(
            directory.resolve("e.experiment.json"),
            """{"schemaVersion":4,"modelRef":"m.model.json","execution":{"replications":1,"warmup":"0s","measurement":"2s","seed":1},"variants":[{"id":"baseline"}]}""",
        )
        FileWorkspace(directory).use { workspace ->
            Lab(workspace).use { lab ->
                assertThat(lab.validate("e.experiment.json").valid).isTrue()
                for (action in listOf<() -> Any>(
                    { lab.estimate("e.experiment.json") },
                    { lab.run("e.experiment.json", "unsupported") },
                )) {
                    val failure = catchThrowable { action() }
                    assertThat(failure).isInstanceOf(InvalidExperimentException::class.java)
                    assertThat((failure as InvalidExperimentException).diagnostics.map { it.code })
                        .contains("EXECUTION_UNSUPPORTED_SCENARIO")
                }
                assertThat(Files.exists(directory.resolve(".results"))).isFalse()
            }
        }
    }

    @Test
    fun replicaExpansionRebindsEveryNestedConnection() {
        val result = compile(modelText().replace("\"handlers\":4", "\"handlers\":4,\"replicas\":2"))
        assertThat(result.diagnostics).isEmpty()
        val graph =
            requireNotNull(result.experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(graph.services.filter { it.path.startsWith("entry") }.flatMap { it.scenario!!.connectionPaths().toList() })
            .containsExactlyInAnyOrder("to-redis#1", "to-db#1", "to-redis#2", "to-db#2")
        val read =
            (
                graph.services
                    .first { it.path == "entry#1" }
                    .scenario!!
                    .single() as ServiceStep.Parallel
            ).branches
                .single()
                .single() as ServiceStep.CacheRead
        assertThat(read.id).isEqualTo("product-read")
        assertThat(read.repeat?.count).isEqualTo(20)
        assertThat(read.onMiss.single()).isInstanceOf(ServiceStep.Call::class.java)
        assertThat(
            graph.services
                .single { it.path == "redis" }
                .cache
                ?.ttlMs,
        ).isEqualTo(60000.0)
    }

    @Test
    fun cacheStructuresAreWholeVariantOverridesAndNeverGridAxes() {
        for (name in listOf("keySpaces", "prefill")) {
            val value = if (name == "prefill") """{"kind":"none"}""" else """[{"id":"product","keys":1000,"zipf":0}]"""
            assertThat(compile(overrides = """{"redis.$name":$value}""").diagnostics).isEmpty()
            val result = compile(grid = """[{"path":"redis.$name","values":[$value]}]""")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("CACHE_STRUCTURE_PATH")
        }
    }

    @Test
    fun `version seven documents preserve nested steps and block titles`() {
        val model = model()
        assertThat(model.blocks.getValue("redis").type).isEqualTo("cache")
        val encoded = DocumentCodec.encodeModel(model)
        assertThat(encoded).contains("Кэш товаров", "product-read", "onMiss", "branches", "singleFlight")
        assertThat(DocumentCodec.decodeModel(encoded, "model.json")).isEqualTo(DecodeResult.Ok(model))
    }

    @Test
    fun `nested cache reads and parallel branches compile with reachable calls`() {
        val result = compile()
        assertThat(result.diagnostics).isEmpty()
        val graph =
            requireNotNull(result.experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(graph.services.map { it.path }).containsExactly("entry", "db", "redis")
        assertThat(graph.callPaths().map { it.map { edge -> edge.path } }.toList())
            .contains(listOf("to-redis"), listOf("to-db"))
    }

    @Test
    fun `repeat count overrides and grid values reach nested steps`() {
        val result =
            compile(
                overrides = """{"entry.steps.product-read.repeat.count":2}""",
                grid = """[{"path":"entry.steps.product-read.repeat.count","values":[3,5]}]""",
            )
        assertThat(result.diagnostics).isEmpty()
        val points = requireNotNull(result.experiment).variants.single().points
        assertThat(points).hasSize(2)
        assertThat(
            points[0]
                .graph.services
                .first { it.path == "entry" }
                .scenario
                .toString(),
        ).contains("count=3")
        assertThat(
            points[1]
                .graph.services
                .first { it.path == "entry" }
                .scenario
                .toString(),
        ).contains("count=5")
    }

    @Test
    fun `invalid nested scenarios report their exact field`() {
        for ((before, after, code, pointer) in listOf(
            listOf("\"id\":\"product-read\",", "", "SCENARIO_ID_REQUIRED", "/blocks/entry/scenario/0/branches/0/0/id"),
            listOf("\"id\":\"product-read\"", "\"id\":\"bad.id\"", "SCENARIO_ID", "/blocks/entry/scenario/0/branches/0/0/id"),
            listOf("\"count\":20", "\"count\":0", "SCENARIO_REPEAT", "/blocks/entry/scenario/0/branches/0/0/repeat/count"),
            listOf("\"mode\":\"parallel\"", "\"mode\":\"unknown\"", "SCENARIO_REPEAT", "/blocks/entry/scenario/0/branches/0/0/repeat/mode"),
            listOf(
                "\"keySpace\":\"product\"",
                "\"keySpace\":\"unknown\"",
                "CACHE_KEY_SPACE",
                "/blocks/entry/scenario/0/branches/0/0/keySpace",
            ),
            listOf(
                "\"connection\":\"to-redis\"",
                "\"connection\":\"to-db\"",
                "CACHE_CONNECTION",
                "/blocks/entry/scenario/0/branches/0/0/connection",
            ),
            listOf(
                "\"onCacheError\":\"source\"",
                "\"onCacheError\":\"unknown\"",
                "CACHE_ERROR_POLICY",
                "/blocks/entry/scenario/0/branches/0/0/onCacheError",
            ),
            listOf(
                "\"onMiss\":[{\"type\":\"call\",\"connection\":\"to-db\"}]",
                "\"onMiss\":[{\"type\":\"call\",\"connection\":\"to-redis\"}]",
                "CACHE_CALL",
                "/blocks/entry/scenario/0/branches/0/0/onMiss/0/connection",
            ),
        )) {
            val result = compile(modelText().replace(before, after))
            assertThat(result.experiment).describedAs(after).isNull()
            assertThat(result.diagnostics.filter { it.code == code }.map { it.pointer }).describedAs(after).contains(pointer)
        }
    }

    @Test
    fun `parallel branches must contain at least one step`() {
        for (scenario in listOf("""[{"type":"parallel","branches":[]}]""", """[{"type":"parallel","branches":[[]]}]""")) {
            val result = compile(withScenario(scenario))
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("SCENARIO_BRANCHES")
        }
    }

    @Test
    fun `step ids are unique across all nesting levels`() {
        val result =
            compile(
                modelText().replace(
                    "\"type\":\"call\",\"connection\":\"to-db\"",
                    "\"type\":\"call\",\"id\":\"product-read\",\"connection\":\"to-db\"",
                ),
            )
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code }).contains("SCENARIO_ID_DUPLICATE")
    }

    @Test
    fun `cache rejects scenarios replicas invalid spaces and overflowing prefill`() {
        for ((before, after, code) in listOf(
            Triple("\"title\":\"Кэш товаров\"", "\"title\":\"Кэш товаров\",\"scenario\":[{\"type\":\"process\"}]", "SCENARIO_BLOCK"),
            Triple("\"capacity\":100", "\"capacity\":100,\"replicas\":2", "CACHE_REPLICAS"),
            Triple("\"keys\":1000", "\"keys\":0", "PARAM_RANGE"),
            Triple("\"zipf\":1.0", "\"zipf\":-1", "PARAM_RANGE"),
            Triple("\"ttl\":\"30s\"", "\"ttl\":\"0s\"", "PARAM_RANGE"),
            Triple("\"keys\":10", "\"keys\":1001", "CACHE_PREFILL"),
            Triple("\"capacity\":100", "\"capacity\":9", "CACHE_PREFILL"),
        )) {
            val result = compile(modelText().replace(before, after))
            assertThat(result.experiment).describedAs(after).isNull()
            assertThat(result.diagnostics.map { it.code }).describedAs(after).contains(code)
        }
    }

    @Test
    fun `repeat paths require an existing id with repeat and a positive integer`() {
        for (path in listOf("entry.steps.missing.repeat.count", "entry.steps.outer.repeat.count")) {
            val result = compile(overrides = """{"$path":2}""")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("SCENARIO_REPEAT_PATH")
        }
        for (value in listOf("0", "1.5", "\"2\"", "null")) {
            val result = compile(overrides = """{"entry.steps.product-read.repeat.count":$value}""")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains("/variants/0/overrides/entry.steps.product-read.repeat.count")
        }
    }

    @Test
    fun `flush requires a cache target and an instant within the run`() {
        assertThat(compile(faults = """[{"target":"redis","kind":"flush","at":"1s"}]""").diagnostics).isEmpty()
        for (fault in listOf(
            """{"target":"db","kind":"flush","at":"1s"}""",
            """{"target":"redis","kind":"flush","at":"3s"}""",
            """{"target":"redis","kind":"flush"}""",
            """{"target":"redis","kind":"flush","at":"1s","from":"0s","to":"1s"}""",
        )) {
            val result = compile(faults = "[$fault]")
            assertThat(result.experiment).describedAs(fault).isNull()
            assertThat(result.diagnostics.any { it.code.startsWith("FAULT_") }).describedAs(fault).isTrue()
        }
    }

    @Test
    fun `titles are nonblank and at most eighty characters`() {
        for (title in listOf("", " ", "x".repeat(81))) {
            val result = compile(modelText().replace("Кэш товаров", title))
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("BLOCK_TITLE")
        }
        assertThat(compile(modelText().replace("Кэш товаров", "x".repeat(80))).diagnostics).isEmpty()
    }

    private fun withScenario(scenario: String): String {
        val root = Json.parseToJsonElement(modelText()) as JsonObject
        val blocks = root["blocks"] as JsonObject
        val entry = blocks["entry"] as JsonObject
        return JsonObject(
            root + ("blocks" to JsonObject(blocks + ("entry" to JsonObject(entry + ("scenario" to Json.parseToJsonElement(scenario)))))),
        ).toString()
    }

    private fun model(text: String = modelText()): ModelFile {
        val decoded = DocumentCodec.decodeModel(text, "m.model.json")
        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        return (decoded as DecodeResult.Ok).value
    }

    private fun compile(
        text: String = modelText(),
        overrides: String = "{}",
        grid: String = "[]",
        faults: String = "[]",
    ): CompileResult {
        val experiment =
            DocumentCodec.decodeExperiment(
                """{"schemaVersion":4,"modelRef":"m.model.json","execution":{"replications":1,"warmup":"0s","measurement":"2s","seed":1},"variants":[{"id":"baseline","overrides":$overrides}],"grid":$grid,"faults":$faults}""",
                "e.experiment.json",
            )
        assertThat(experiment).isInstanceOf(DecodeResult.Ok::class.java)
        return ModelCompiler().compile(
            model(text),
            "m.model.json",
            (experiment as DecodeResult.Ok<ExperimentFile>).value,
            "e.experiment.json",
        )
    }

    private fun modelText(): String =
        """{"schemaVersion":7,"blocks":{
      "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"1/s"}]},"deadline":"1s"}},
      "entry":{"type":"service","params":{"handlers":4,"processing":{"kind":"fixed","mean":"0ms"}},"scenario":[{"type":"parallel","id":"outer","branches":[[{"type":"cacheRead","id":"product-read","connection":"to-redis","keySpace":"product","singleFlight":true,"onCacheError":"source","repeat":{"count":20,"mode":"parallel"},"onMiss":[{"type":"call","connection":"to-db"}]}]]}]},
      "redis":{"type":"cache","title":"Кэш товаров","params":{"capacity":100,"keySpaces":[{"id":"product","keys":1000,"zipf":1.0,"ttl":"30s"}],"prefill":{"kind":"hot","keys":10}}},
      "db":{"type":"database","params":{"maxConnections":10,"processing":{"kind":"fixed","mean":"5ms"}}}
    },"connections":[{"id":"request","type":"request","from":"client","to":"entry"},{"id":"to-redis","type":"call","from":"entry","to":"redis","params":{"timeout":"50ms"}},{"id":"to-db","type":"call","from":"entry","to":"db","params":{"timeout":"50ms"}}]}"""
}
