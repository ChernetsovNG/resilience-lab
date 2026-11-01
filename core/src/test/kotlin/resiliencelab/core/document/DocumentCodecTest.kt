package resiliencelab.core.document

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class DocumentCodecTest {
    @Test
    fun `layout two round-trips manual geometry and accepts omitted maps`() {
        val source = """{"schemaVersion":2,"positions":{"missing":{"x":-1.5,"y":0.0}},
            "sizes":{"missing":{"width":240.0,"height":200.0}},
            "edges":{"missing-edge":{"points":[{"x":520.0,"y":330.0},{"x":520.0,"y":120.0}]}}}"""
        val decoded = DocumentCodec.decodeLayout(source, "test.layout.json")
        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        val encoded = DocumentCodec.encodeLayout((decoded as DecodeResult.Ok).value)
        assertThat(Json.parseToJsonElement(encoded)).isEqualTo(Json.parseToJsonElement(source))
        assertThat(DocumentCodec.decodeLayout(encoded, "test.layout.json")).isEqualTo(decoded)
        assertThat(DocumentCodec.decodeLayout("""{"schemaVersion":2}""", "test.layout.json"))
            .isInstanceOf(DecodeResult.Ok::class.java)
    }

    @Test
    fun `old layout reports version before obsolete shape`() {
        val decoded = DocumentCodec.decodeLayout("""{"schemaVersion":1,"oldShape":true}""", "old.layout.json")
        val diagnostic = (decoded as DecodeResult.Failed).diagnostics.single()
        assertThat(diagnostic.code to diagnostic.pointer).isEqualTo("SCHEMA_VERSION" to "/schemaVersion")
        assertThat(diagnostic.args).containsEntry("expected", JsonPrimitive(2))
    }

    @Test
    fun `layout sizes must be finite and positive`() {
        for (value in listOf("0", "-1", "1e400", "\"NaN\"", "\"Infinity\"")) {
            for (dimensions in listOf("\"width\":$value,\"height\":1", "\"width\":1,\"height\":$value")) {
                val decoded =
                    DocumentCodec.decodeLayout(
                        """{"schemaVersion":2,"sizes":{"a":{$dimensions}}}""",
                        "test.layout.json",
                    )
                assertThat(decoded).describedAs(dimensions).isInstanceOf(DecodeResult.Failed::class.java)
                assertThat((decoded as DecodeResult.Failed).diagnostics.single().code).isNotEqualTo("SCHEMA_VERSION")
            }
        }
    }

    @Test
    fun `layout bends accept fifty finite points and reject fifty one`() {
        for (count in listOf(0, 50, 51)) {
            val points = List(count) { """{"x":-1,"y":2}""" }.joinToString(",")
            val decoded =
                DocumentCodec.decodeLayout(
                    """{"schemaVersion":2,"edges":{"edge":{"points":[$points]}}}""",
                    "test.layout.json",
                )
            assertThat(decoded)
                .describedAs("$count points")
                .isInstanceOf(if (count <= 50) DecodeResult.Ok::class.java else DecodeResult.Failed::class.java)
        }
        for (coordinates in listOf("\"x\":1e400,\"y\":0", "\"x\":0,\"y\":1e400", "\"x\":\"NaN\",\"y\":0")) {
            val decoded =
                DocumentCodec.decodeLayout(
                    """{"schemaVersion":2,"edges":{"edge":{"points":[{$coordinates}]}}}""",
                    "test.layout.json",
                )
            assertThat(decoded).describedAs(coordinates).isInstanceOf(DecodeResult.Failed::class.java)
            assertThat((decoded as DecodeResult.Failed).diagnostics.single().code).isNotEqualTo("SCHEMA_VERSION")
        }
    }

    @Test
    fun `experiment three preserves optional variant descriptions verbatim`() {
        val description = "  Другая реплика\nИсточник: https://example.org/  "
        val source = """{"schemaVersion":3,"modelRef":"m.model.json",
            "execution":{"replications":2,"warmup":"0ms","measurement":"1s","seed":7},
            "variants":[{"id":"baseline","description":${Json.encodeToString(description)}}]}"""

        val decoded = DocumentCodec.decodeExperiment(source, "e.experiment.json")

        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        val encoded = DocumentCodec.encodeExperiment((decoded as DecodeResult.Ok).value)
        val root = Json.parseToJsonElement(encoded).jsonObject
        val variants = root.getValue("variants").jsonArray
        val variant = variants.single().jsonObject
        assertThat(variant["description"]).isEqualTo(JsonPrimitive(description))
        assertThat(DocumentCodec.decodeExperiment(encoded, "e.experiment.json")).isEqualTo(decoded)
    }

    @Test
    fun `old experiments report their version before obsolete shape`() {
        for (version in listOf(1, 2)) {
            val decoded = DocumentCodec.decodeExperiment("""{"schemaVersion":$version,"oldShape":true}""", "old.experiment.json")
            val diagnostic = (decoded as DecodeResult.Failed).diagnostics.single()
            assertThat(diagnostic.code to diagnostic.pointer).isEqualTo("SCHEMA_VERSION" to "/schemaVersion")
            assertThat(diagnostic.message).isEqualTo("Unsupported schemaVersion $version; expected 3")
            assertThat(diagnostic.args).containsEntry("expected", JsonPrimitive(3))
        }
    }

    @Test
    fun `reads experiment faults and keeps layout at version two`() {
        val text =
            """{"schemaVersion":3,"modelRef":"m.model.json",
              "execution":{"replications":1,"warmup":"0ms","measurement":"1s","seed":1},
              "faults":[
                {"target":"service","from":"0ms","to":"1s","kind":"slowdown","multiplier":2,"delay":"20ms"},
                {"target":"service","from":"0ms","to":"1s","kind":"errors","failureRate":"5%"},
                {"target":"service","from":"0ms","to":"1s","kind":"unavailable"},
                {"target":"service","from":"0ms","to":"1s","kind":"blackhole"},
                {"target":"service","from":"0ms","to":"1s","kind":"capacityLoss","capacity":0}
              ],"variants":[{"id":"baseline"}]}"""

        val decoded = DocumentCodec.decodeExperiment(text, "e.experiment.json")

        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        val experiment = (decoded as DecodeResult.Ok).value
        assertThat(experiment.faults).hasSize(5)
        assertThat(DocumentCodec.decodeExperiment(DocumentCodec.encodeExperiment(experiment), "e.experiment.json"))
            .isEqualTo(decoded)
        assertThat(DocumentCodec.decodeLayout("""{"schemaVersion":2,"positions":{}}""", "l.layout.json"))
            .isInstanceOf(DecodeResult.Ok::class.java)
        val old = DocumentCodec.decodeExperiment("""{"schemaVersion":1,"oldShape":true}""", "old.experiment.json")
        val diagnostic = (old as DecodeResult.Failed).diagnostics.single()
        assertThat(diagnostic.code to diagnostic.pointer).isEqualTo("SCHEMA_VERSION" to "/schemaVersion")
        assertThat(diagnostic.args).containsEntry("expected", JsonPrimitive(3))
    }

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
        val text = """{"schemaVersion": 6, "blocks": {"c": {"type": "client"}}, "connections": []}"""
        val decoded = DocumentCodec.decodeModel(text, "m.model.json")
        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        assertThat((decoded as DecodeResult.Ok).value.blocks.keys).containsExactly("c")

        val unknownField = DocumentCodec.decodeModel("""{"schemaVersion": 6, "blocks": {}, "extra": 1}""", "m.model.json")
        assertThat((unknownField as DecodeResult.Failed).diagnostics.single().code).isEqualTo("DOCUMENT_SHAPE")

        for (version in listOf(1, 4, 5)) {
            val wrongVersion = DocumentCodec.decodeModel("""{"schemaVersion":$version,"oldShape":{}}""", "m.model.json")
            val diagnostic = (wrongVersion as DecodeResult.Failed).diagnostics.single()
            assertThat(diagnostic.code).isEqualTo("SCHEMA_VERSION")
            assertThat(diagnostic.pointer).isEqualTo("/schemaVersion")
            assertThat(diagnostic.message).isEqualTo("Unsupported schemaVersion $version; expected 6")
            assertThat(Json.encodeToJsonElement(diagnostic).jsonObject["args"])
                .isEqualTo(Json.parseToJsonElement("""{"actual":$version,"expected":6}"""))
        }
    }

    @Test
    fun `writes canonical text with sorted keys, two-space indent and a final newline`() {
        val model =
            ModelFile(
                schemaVersion = 6,
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
              "schemaVersion": 6
            }

            """.trimIndent(),
        )
        assertThat((DocumentCodec.decodeModel(text, "m.model.json") as DecodeResult.Ok).value).isEqualTo(model)
    }

    @Test
    fun `round-trips experiment and layout documents`() {
        val experiment =
            ExperimentFile(
                schemaVersion = 3,
                modelRef = "m.model.json",
                execution = ExecutionSettings(replications = 2, warmup = "0ms", measurement = "1s", seed = 7),
                variants = listOf(Variant(id = "baseline")),
            )
        val layout = LayoutFile(schemaVersion = 2, positions = mapOf("a" to Position(0.0, 100.0)))

        val decodedExperiment = DocumentCodec.decodeExperiment(DocumentCodec.encodeExperiment(experiment), "e.experiment.json")
        val decodedLayout = DocumentCodec.decodeLayout(DocumentCodec.encodeLayout(layout), "l.layout.json")

        assertThat((decodedExperiment as DecodeResult.Ok).value).isEqualTo(experiment)
        assertThat((decodedLayout as DecodeResult.Ok).value).isEqualTo(layout)
    }

    @Test
    fun `keeps descriptions and notes of documents, blocks and connections`() {
        val model =
            ModelFile(
                schemaVersion = 6,
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
