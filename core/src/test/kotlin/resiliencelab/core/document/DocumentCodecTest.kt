package resiliencelab.core.document

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class DocumentCodecTest {
    @Test
    fun `empty whitespace and multiple root values are shape diagnostics instead of exceptions`() {
        for (text in listOf("", " \n\t", "{} {}")) {
            for (decoded in listOf(
                DocumentCodec.decodeModel(text, "m.model.json"),
                DocumentCodec.decodeExperiment(text, "e.experiment.json"),
                DocumentCodec.decodeLayout(text, "l.layout.json"),
            )) {
                assertThat(decoded).describedAs(text).isInstanceOf(DecodeResult.Failed::class.java)
                assertThat((decoded as DecodeResult.Failed).diagnostics.single().code).isIn("DOCUMENT_SHAPE", "JSON_SYNTAX")
            }
        }
    }

    @Test
    fun `rejects duplicate keys, non-finite numbers and syntax errors`() {
        val duplicate = StrictJson.check("""{"a": 1, "a": 2}""", "x.json")!!
        assertThat(duplicate.code).isEqualTo("JSON_DUPLICATE_KEY")
        assertThat(duplicate.args?.get("key")).isEqualTo(JsonPrimitive("a"))
        assertThat(duplicate.args?.get("line")?.intOrNull).isEqualTo(1)
        assertThat(duplicate.args?.get("column")?.intOrNull).isPositive()
        assertThat(StrictJson.check("""{"a": 1e400}""", "x.json")!!.code).isEqualTo("JSON_NON_FINITE")
        assertThat(StrictJson.check("""{"a": NaN}""", "x.json")!!.code).isEqualTo("JSON_SYNTAX")
        assertThat(StrictJson.check("""{"a": [1, 2.5, "x"]}""", "x.json")).isNull()
    }

    @Test
    fun `reports parser constraints as syntax diagnostics`() {
        val deeplyNested = "[".repeat(1001) + "0" + "]".repeat(1001)

        assertThat(StrictJson.check(deeplyNested, "deep.json")?.code).isEqualTo("JSON_SYNTAX")
    }

    @Test
    fun `decodes a model and reports shape and version problems`() {
        val text = """{"schemaVersion": 3, "blocks": {"c": {"type": "client"}}, "connections": []}"""
        val decoded = DocumentCodec.decodeModel(text, "m.model.json")
        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        assertThat((decoded as DecodeResult.Ok).value.blocks.keys).containsExactly("c")

        val unknownField = DocumentCodec.decodeModel("""{"schemaVersion": 3, "blocks": {}, "extra": 1}""", "m.model.json")
        assertThat((unknownField as DecodeResult.Failed).diagnostics.single().code).isEqualTo("DOCUMENT_SHAPE")

        val wrongVersion = DocumentCodec.decodeModel("""{"schemaVersion": 1, "oldShape": {}}""", "m.model.json")
        val diagnostic = (wrongVersion as DecodeResult.Failed).diagnostics.single()
        assertThat(diagnostic.code).isEqualTo("SCHEMA_VERSION")
        assertThat(diagnostic.pointer).isEqualTo("/schemaVersion")
        assertThat(diagnostic.message).isEqualTo("Unsupported schemaVersion 1; expected 3")
        assertThat(Json.encodeToJsonElement(diagnostic).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"actual":1,"expected":3}"""))
    }

    @Test
    fun `writes canonical text with sorted keys, two-space indent and a final newline`() {
        val model =
            ModelFile(
                schemaVersion = 3,
                blocks =
                    linkedMapOf(
                        "b" to
                            BlockInstance(
                                type = "service",
                                params =
                                    buildJsonObject {
                                        put("queue", 1)
                                        put("handlers", 2)
                                    },
                            ),
                        "a" to BlockInstance(type = "client"),
                    ),
            )

        val text = DocumentCodec.encodeModel(model)

        assertThat(text).isEqualTo(
            """
            {
              "blocks": {
                "a": {
                  "type": "client"
                },
                "b": {
                  "params": {
                    "handlers": 2,
                    "queue": 1
                  },
                  "type": "service"
                }
              },
              "schemaVersion": 3
            }

            """.trimIndent(),
        )
        assertThat((DocumentCodec.decodeModel(text, "m.model.json") as DecodeResult.Ok).value).isEqualTo(model)
    }

    @Test
    fun `round-trips experiment and layout documents`() {
        val experiment =
            ExperimentFile(
                schemaVersion = 1,
                modelRef = "m.model.json",
                execution = ExecutionSettings(replications = 2, warmup = "0ms", measurement = "1s", seed = 7),
                variants = listOf(Variant(id = "baseline")),
            )
        val layout = LayoutFile(schemaVersion = 1, positions = mapOf("a" to Position(0.0, 100.0)))

        val decodedExperiment = DocumentCodec.decodeExperiment(DocumentCodec.encodeExperiment(experiment), "e.experiment.json")
        val decodedLayout = DocumentCodec.decodeLayout(DocumentCodec.encodeLayout(layout), "l.layout.json")

        assertThat((decodedExperiment as DecodeResult.Ok).value).isEqualTo(experiment)
        assertThat((decodedLayout as DecodeResult.Ok).value).isEqualTo(layout)
    }

    @Test
    fun `keeps descriptions and notes of documents, blocks and connections`() {
        val model =
            ModelFile(
                schemaVersion = 3,
                description = "Chain",
                notes = "Calibrated on staging",
                blocks = mapOf("a" to BlockInstance(type = "client", description = "Load", notes = "Peak hour")),
                connections =
                    listOf(
                        ConnectionInstance(
                            id = "c",
                            type = "request",
                            from = "a",
                            to = "b",
                            description = "Entry",
                            notes = "Direct",
                        ),
                    ),
            )

        val text = DocumentCodec.encodeModel(model)

        assertThat((DocumentCodec.decodeModel(text, "m.model.json") as DecodeResult.Ok).value).isEqualTo(model)
        assertThat(text).contains("\"notes\": \"Peak hour\"", "\"notes\": \"Direct\"")
    }
}
