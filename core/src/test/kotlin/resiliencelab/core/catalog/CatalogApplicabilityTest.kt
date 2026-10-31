package resiliencelab.core.catalog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExecutionSettings
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.Variant
import resiliencelab.core.engine.ksl.RetryPolicyEvaluator
import kotlin.test.Test

class CatalogApplicabilityTest {
    private val json = Json { encodeDefaults = true }
    private val catalog = Stage1Catalog.catalog
    private val source =
        """
        {"schemaVersion":6,"blocks":{
          "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"1/s"}]},"deadline":"1s"}},
          "service":{"type":"service","params":{"handlers":4,"processing":{"kind":"fixed","mean":"5ms"}}},
          "pooler":{"type":"pooler","params":{"maxClientConnections":4,"poolSize":2,"waitTimeout":"20ms","processing":{"kind":"fixed","mean":"5ms"}}},
          "database":{"type":"database","params":{"maxConnections":4,"processing":{"kind":"fixed","mean":"5ms"}}}
        },"connections":[
          {"id":"request","type":"request","from":"client","to":"service"},
          {"id":"rpc","type":"call","from":"service","to":"pooler","params":{"timeout":"100ms","attempts":3}},
          {"id":"query","type":"call","from":"pooler","to":"database","params":{"timeout":"50ms"}}
        ]}
        """.trimIndent()

    private fun rules(): Map<String, JsonObject> =
        buildMap {
            fun visit(
                fields: List<ParamDescriptor>,
                prefix: String,
            ) {
                fields.forEach { field ->
                    val encoded = json.encodeToJsonElement(ParamDescriptor.serializer(), field).jsonObject
                    encoded["appliesWhen"]?.takeUnless { it == JsonNull }?.let { put("$prefix.${field.name}", it.jsonObject) }
                    visit(field.fields, "$prefix.${field.name}")
                }
            }
            catalog.types.forEach { visit(it.params, it.id) }
        }

    private fun compile(
        type: String,
        parameter: String,
        value: JsonObject,
        scenario: Boolean = false,
    ): resiliencelab.core.compiler.CompileResult {
        val root = Json.parseToJsonElement(source).jsonObject.toMutableMap()
        if (type == "call") {
            root["connections"] =
                kotlinx.serialization.json.JsonArray(
                    root.getValue("connections").jsonArray.map { connection ->
                        if (connection.jsonObject
                                .getValue("id")
                                .jsonPrimitive.content != "rpc"
                        ) {
                            connection
                        } else {
                            JsonObject(
                                connection.jsonObject +
                                    ("params" to JsonObject(connection.jsonObject.getValue("params").jsonObject + (parameter to value))),
                            )
                        }
                    },
                )
        } else {
            val blocks = root.getValue("blocks").jsonObject
            val block = blocks.getValue(type).jsonObject
            val updated =
                if (scenario) {
                    block +
                        (
                            "scenario" to
                                Json.parseToJsonElement("""[{"type":"process","processing":$value},{"type":"call","connection":"rpc"}]""")
                        )
                } else {
                    block + ("params" to JsonObject(block.getValue("params").jsonObject + (parameter to value)))
                }
            root["blocks"] = JsonObject(blocks + (type to JsonObject(updated)))
        }
        val model = (DocumentCodec.decodeModel(JsonObject(root).toString(), "m.model.json") as DecodeResult.Ok).value
        return ModelCompiler().compile(
            model,
            "m.model.json",
            ExperimentFile(
                2,
                modelRef = "m.model.json",
                execution = ExecutionSettings(2, "0s", "1s", 1),
                variants = listOf(Variant("baseline")),
            ),
            "e.experiment.json",
        )
    }

    @Test
    fun `every distribution and backoff field declares its applicability`() {
        assertThat(rules().keys).containsExactlyInAnyOrder(
            "service.processing.stdDev",
            "database.processing.stdDev",
            "pooler.processing.stdDev",
            "call.network.stdDev",
            "call.backoff.base",
            "call.backoff.max",
            "call.backoff.multiplier",
        )
        rules().forEach { (_, rule) -> assertThat(rule.getValue("field")).isEqualTo(JsonPrimitive("kind")) }
    }

    @Test
    fun `distribution annotations agree with compiler acceptance including scenario processing`() {
        rules().filterKeys { it.endsWith(".stdDev") }.forEach { (path, rule) ->
            val (type, parameter) = path.split('.')
            listOf("fixed", "exponential", "lognormal").forEach { kind ->
                val value = Json.parseToJsonElement("""{"kind":"$kind","mean":"5ms","stdDev":"2ms"}""").jsonObject
                listOf(false, true).filter { !it || type == "service" }.forEach { scenario ->
                    val result = compile(type, parameter, value, scenario)
                    if (JsonPrimitive(kind) in rule.getValue("values").jsonArray) {
                        assertThat(result.diagnostics).describedAs("%s, scenario=%s", path, scenario).isEmpty()
                        assertThat(result.experiment).isNotNull()
                        assertThat(
                            compile(type, parameter, JsonObject(value - "stdDev"), scenario).diagnostics.map {
                                it.code
                            },
                        ).describedAs("%s, scenario=%s", path, scenario)
                            .contains("PARAM_MISSING")
                    } else {
                        assertThat(result.diagnostics.map { it.code }).describedAs(path).contains("DISTRIBUTION_RULE")
                    }
                }
            }
        }
    }

    @Test
    fun `backoff annotations agree with delays from the compiled policy`() {
        val alternatives: Map<String, JsonElement> =
            mapOf(
                "base" to JsonPrimitive("7ms"),
                "max" to JsonPrimitive("1ms"),
                "multiplier" to JsonPrimitive(5),
            )
        rules().filterKeys { it.startsWith("call.backoff.") }.forEach { (path, rule) ->
            listOf("none", "fixed", "exponential-full-jitter").forEach { kind ->
                val original = Json.parseToJsonElement("""{"kind":"$kind","base":"2ms","max":"20ms","multiplier":3}""").jsonObject

                fun delays(value: JsonObject): List<Double> {
                    val result = compile("call", "backoff", value)
                    assertThat(result.diagnostics).isEmpty()
                    val backoff =
                        result.experiment!!
                            .variants
                            .single()
                            .points
                            .single()
                            .graph.calls
                            .first { it.path == "rpc" }
                            .backoff
                    return (1..3).map { RetryPolicyEvaluator.backoffMs(backoff, it) { 0.5 } }
                }
                val field = path.substringAfterLast('.')
                val changed = delays(JsonObject(original + (field to alternatives.getValue(field))))
                if (JsonPrimitive(kind) in rule.getValue("values").jsonArray) {
                    assertThat(changed).isNotEqualTo(delays(original))
                } else {
                    assertThat(changed).isEqualTo(delays(original))
                }
            }
        }
    }
}
