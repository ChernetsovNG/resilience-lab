package resiliencelab.core.document

import com.networknt.schema.InputFormat
import com.networknt.schema.JsonSchemaFactory
import com.networknt.schema.SchemaLocation
import com.networknt.schema.SpecVersion.VersionFlag
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.ParamKind
import resiliencelab.core.catalog.QuantityUnit
import resiliencelab.core.catalog.Stage1Catalog
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class DocumentSchemasTest {
    @Test
    fun `experiment three validates optional variant descriptions and rejects version two`() {
        val source =
            experiment().replace("\"id\":\"baseline\"", "\"id\":\"baseline\",\"description\":\"Другая реплика\"")
        assertThat(validate("experiment", source)).isEmpty()
        assertThat(validate("experiment", source.replace("\"schemaVersion\":3", "\"schemaVersion\":2"))).isNotEmpty()
        assertThat(validate("experiment", source.replace("\"description\":\"Другая реплика\"", "\"description\":42"))).isNotEmpty()
    }

    @Test
    fun `client class profiles and structural filters follow the model six schema`() {
        val load = """{"points":[{"time":"0s","rate":"10/s"}]}"""
        val classes = """[{"id":"read","load":$load}]"""
        val source = """{"schemaVersion":6,"blocks":{
            "client":{"type":"client","params":{"deadline":"1s","classes":$classes}},
            "service":{"type":"service","params":{"handlers":2,"processing":{"kind":"fixed","mean":"1ms"}},
                "scenario":[{"type":"process","classes":["read"]}]},
            "router":{"type":"router","params":{"policy":"random"}}
        },"connections":[{"id":"route","type":"route","from":"router","to":"service","classes":["read"]}]}"""
        assertThat(validate("model", source)).isEmpty()
        listOf(
            source.replace("\"classes\":$classes", "\"classes\":$classes,\"load\":$load"),
            source.replace("\"classes\":$classes", "\"classes\":[]"),
            source.replace("\"id\":\"read\"", "\"id\":42"),
            source.replace("\"classes\":[\"read\"]", "\"classes\":[]"),
            source.replace("\"classes\":[\"read\"]", "\"classes\":[\"read\",\"read\"]"),
            source.replace("\"type\":\"route\"", "\"type\":\"request\""),
            source.replace("\"schemaVersion\":6", "\"schemaVersion\":5"),
        ).forEach { invalid ->
            assertThat(validate("model", invalid)).describedAs(invalid).isNotEmpty()
        }
        val decoded = DocumentCodec.decodeModel(source, "classes.model.json") as DecodeResult.Ok
        val encoded = DocumentCodec.encodeModel(decoded.value)
        val roundTrip = DocumentCodec.decodeModel(encoded, "classes.model.json") as DecodeResult.Ok
        assertThat(roundTrip.value).isEqualTo(decoded.value)
        assertThat(
            roundTrip.value.connections
                .single()
                .classes,
        ).containsExactly("read")
        assertThat(
            roundTrip.value.blocks
                .getValue("service")
                .scenario!!
                .single()
                .classes,
        ).containsExactly("read")
    }

    @Test
    fun `fault schema accepts kind parameters and rejects missing or unrelated values`() {
        fun withFault(fields: String) =
            experiment().replace(
                "\"variants\":",
                "\"faults\":[{\"target\":\"service\",\"from\":\"0ms\",\"to\":\"1s\",$fields}],\"variants\":",
            )
        for (fields in listOf(
            "\"kind\":\"slowdown\",\"multiplier\":2",
            "\"kind\":\"slowdown\",\"delay\":\"0ms\"",
            "\"kind\":\"slowdown\",\"multiplier\":2,\"delay\":\"20ms\"",
            "\"kind\":\"errors\",\"failureRate\":\"5%\"",
            "\"kind\":\"capacityLoss\",\"capacity\":0",
            "\"kind\":\"unavailable\"",
            "\"kind\":\"blackhole\"",
        )) {
            assertThat(validate("experiment", withFault(fields))).describedAs(fields).isEmpty()
        }
        for (fields in listOf(
            "\"kind\":\"periodic\"",
            "\"kind\":\"slowdown\"",
            "\"kind\":\"slowdown\",\"multiplier\":0",
            "\"kind\":\"slowdown\",\"multiplier\":null",
            "\"kind\":\"slowdown\",\"delay\":\"-1ms\"",
            "\"kind\":\"slowdown\",\"multiplier\":2,\"failureRate\":\"5%\"",
            "\"kind\":\"errors\"",
            "\"kind\":\"errors\",\"failureRate\":null",
            "\"kind\":\"errors\",\"failureRate\":\"5%\",\"capacity\":0",
            "\"kind\":\"capacityLoss\"",
            "\"kind\":\"capacityLoss\",\"capacity\":-1",
            "\"kind\":\"unavailable\",\"delay\":\"1ms\"",
            "\"kind\":\"blackhole\",\"multiplier\":2",
            "\"processingMultiplier\":2",
        )) {
            assertThat(validate("experiment", withFault(fields))).describedAs(fields).isNotEmpty()
        }
    }

    private val root = Path.of(System.getProperty("resilience-lab.project-root"))
    private val factory = JsonSchemaFactory.getInstance(VersionFlag.V202012)
    private val generated = DocumentSchemas().generate()

    @Test
    fun `replica overrides validate partial service parameters including nested fields`() {
        val source =
            model.replace(
                "\"s\":{\"type\":\"service\"",
                "\"s\":{\"type\":\"service\",\"replicaOverrides\":{\"2\":{\"processing\":{\"mean\":\"4ms\"},\"handlers\":3}}",
            )
        assertThat(validate("model", source)).isEmpty()
        for (invalid in listOf(
            source.replace("\"handlers\":3", "\"handlers\":0"),
            source.replace("\"handlers\":3", "\"handlers\":2.5"),
            source.replace("\"handlers\":3", "\"unknown\":3"),
            source.replace("\"handlers\":3", "\"replicas\":3"),
            source.replace("\"mean\":\"4ms\"", "\"mean\":\"4/s\""),
            source.replace("\"2\":{", "\"0\":{"),
            source.replace("\"type\":\"service\",\"replicaOverrides\"", "\"type\":\"router\",\"replicaOverrides\""),
        )) {
            assertThat(validate("model", invalid)).describedAs(invalid).isNotEmpty()
        }
    }

    @Test
    fun `committed document schemas match serializers and catalog`() {
        generated.forEach { (name, text) ->
            val file = root.resolve("schemas/$name")
            if (System.getenv("UPDATE_SCHEMAS") == "1") {
                Files.createDirectories(file.parent)
                Files.writeString(file, text)
            }
            assertThat(file).exists()
            assertThat(Files.readString(file))
                .describedAs("schemas/$name is stale; regenerate with UPDATE_SCHEMAS=1")
                .isEqualTo(text)
        }
    }

    @Test
    fun `every example passes its Draft 2020-12 schema`() {
        val kinds = listOf("model", "layout", "experiment")
        kinds.forEach { kind ->
            val file = root.resolve("schemas/$kind.schema.json")
            assertThat(file).exists()
            val schema = factory.getSchema(Files.readString(file), InputFormat.JSON)
            Files.walk(root.resolve("examples")).use { paths ->
                val examples = paths.filter { it.fileName.toString().endsWith(".$kind.json") }.toList()
                assertThat(examples).isNotEmpty()
                examples.forEach { example ->
                    assertThat(schema.validate(Files.readString(example), InputFormat.JSON))
                        .describedAs(example.toString())
                        .isEmpty()
                }
            }
        }
    }

    @Test
    fun `generated schemas pass the Draft 2020-12 meta schema`() {
        val metaSchema = factory.getSchema(SchemaLocation.of("https://json-schema.org/draft/2020-12/schema"))
        generated.forEach { (name, text) ->
            assertThat(metaSchema.validate(text, InputFormat.JSON)).describedAs(name).isEmpty()
        }
    }

    @Test
    fun `rejects unknown types missing parameters wrong units numeric ranges and extra fields`() {
        val invalid =
            listOf(
                model.replace("\"client\"", "\"unknown\""),
                model.replace("\"client\"", "\"call\""),
                model.replace("\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"120/s\"}]},", ""),
                model.replace("\"120/s\"", "120"),
                model.replace("\"120/s\"", "\"120\""),
                model.replace("\"120/s\"", "\"120ms\""),
                model.replace("\"1s\"", "\"1hour\""),
                model.replace("\"handlers\":2", "\"handlers\":0"),
                model.replace("\"handlers\":2", "\"handlers\":2.5"),
                model.replace("\"handlers\":2", "\"handlers\":null"),
                model.replace("\"handlers\":2", "\"handlers\":\"2\""),
                model.replace("\"fixed\"", "\"invalid\""),
                model.replace("\"handlers\":2", "\"handlers\":2,\"extra\":1"),
                model.replace("\"mean\":\"0ms\"", "\"mean\":\"0ms\",\"extra\":1"),
                model.replace("\"type\":\"service\"", "\"type\":\"service\",\"extra\":1"),
                model.replace("\"schemaVersion\":6", "\"schemaVersion\":6,\"extra\":1"),
                model.replace("\"schemaVersion\":6", "\"schemaVersion\":1"),
            )
        invalid.forEach { text ->
            assertThat(validate("model", text)).describedAs(text).isNotEmpty()
        }
        val call =
            model.replace(
                "\"connections\":[]",
                """"connections":[{"id":"call","type":"call","from":"s","to":"s","params":{"timeout":"1s","backoff":{"kind":"fixed","multiplier":0}}}]""",
            )
        assertThat(validate("model", call)).isNotEmpty()
        assertThat(validate("layout", """{"schemaVersion":1,"positions":{"c":{"x":0,"y":1,"z":2}}}""")).isNotEmpty()
        assertThat(validate("layout", """{"schemaVersion":1,"positions":{"c":{"x":0}}}""")).isNotEmpty()
    }

    @Test
    fun `scenario schema accepts process and call steps and rejects wrong shapes`() {
        fun withScenario(steps: String) = model.replace("\"type\":\"service\"", "\"type\":\"service\",\"scenario\":$steps")
        assertThat(
            validate(
                "model",
                withScenario(
                    """[{"type":"process"},{"type":"process","processing":{"kind":"fixed","mean":"2ms"},"failureRate":"1%"},{"type":"call","connection":"db"}]""",
                ),
            ),
        ).isEmpty()
        listOf(
            "[]",
            """[{"type":"parallel"}]""",
            """[{"type":"call"}]""",
            """[{"type":"process","connection":"db"}]""",
            """[{"type":"call","connection":"db","failureRate":"1%"}]""",
            """[{"type":"process","processing":{"kind":"fixed","mean":"2/s"}}]""",
        ).forEach { steps -> assertThat(validate("model", withScenario(steps))).describedAs(steps).isNotEmpty() }
        val nullable =
            withScenario(
                """[{"type":"process","connection":null},{"type":"call","connection":"db","processing":null,"failureRate":null}]""",
            )
        assertThat(DocumentCodec.decodeModel(nullable, "m.model.json")).isInstanceOf(DecodeResult.Ok::class.java)
        assertThat(validate("model", nullable)).isEmpty()
    }

    @Test
    fun `accepts nullable defaults quantities with exponents and cross element mistakes`() {
        assertThat(validate("model", model)).isEmpty()
        val defaults =
            model
                .replace("\"handlers\":2", "\"handlers\":2,\"queue\":null,\"failureRate\":null")
                .replace("\"120/s\"", "\"1.2e2/min\"")
                .replace("\"1s\"", "\"0.5min\"")
                .replace("\"type\":\"client\"", "\"type\":\"client\",\"description\":null,\"notes\":null")
        assertThat(validate("model", defaults)).isEmpty()
        // Invalid references/topology and path-dependent JSON values belong to the compiler.
        val overrides = """{"missing.path":[null,true,{},[1],"1ms"],"other.path":{"arbitrary":false}}"""
        val experiment = experiment(overrides)
        assertThat(validate("experiment", experiment)).isEmpty()
        assertThat(DocumentCodec.decodeExperiment(experiment, "test.experiment.json")).isInstanceOf(DecodeResult.Ok::class.java)
        assertThat(validate("layout", """{"schemaVersion":1,"positions":{"missing/path":{"x":-1.5,"y":0}}}""")).isEmpty()
    }

    @Test
    fun `checks execution number ranges without constraining override values`() {
        listOf(
            experiment().replace("\"replications\":1", "\"replications\":0"),
            experiment().replace("\"seed\":0", "\"seed\":-1"),
            experiment().replace("\"seed\":0", "\"seed\":9007199254740992"),
            experiment().replace("\"warmup\":\"0ms\"", "\"warmup\":\"1/s\""),
            experiment().replace("\"seed\":0", "\"seed\":0,\"extra\":true"),
            experiment().replace("\"id\":\"baseline\"", "\"id\":\"baseline\",\"extra\":true"),
        ).forEach { assertThat(validate("experiment", it)).describedAs(it).isNotEmpty() }
        assertThat(validate("experiment", experiment().replace("\"seed\":0", "\"seed\":9007199254740991"))).isEmpty()
    }

    @Test
    fun `does not reject numeric strings accepted by document decoding`() {
        val layout = """{"schemaVersion":"1","positions":{"c":{"x":"-1.5","y":"0"}}}"""
        assertThat(DocumentCodec.decodeLayout(layout, "test.layout.json")).isInstanceOf(DecodeResult.Ok::class.java)
        assertThat(validate("layout", layout)).isEmpty()
        val experiment = experiment().replace("\"seed\":0", "\"seed\":\"0\"").replace("\"replications\":1", "\"replications\":\"1\"")
        assertThat(DocumentCodec.decodeExperiment(experiment, "test.experiment.json")).isInstanceOf(DecodeResult.Ok::class.java)
        assertThat(validate("experiment", experiment)).isEmpty()
    }

    @Test
    fun `quantity annotations and descriptions agree with every catalog descriptor`() {
        val definitions =
            Json
                .parseToJsonElement(generated.getValue("model.schema.json"))
                .jsonObject
                .getValue("\$defs")
                .jsonObject
        val alternatives =
            listOf("BlockInstance", "ConnectionInstance").flatMap { name ->
                definitions
                    .getValue("resiliencelab.core.document.$name")
                    .jsonObject
                    .getValue("oneOf")
                    .jsonArray
            }
        Stage1Catalog.catalog.types.forEach { type ->
            val shape =
                alternatives.single {
                    it.jsonObject
                        .properties()
                        .getValue("type")
                        .jsonObject["const"] == JsonPrimitive(type.id)
                }
            assertAnnotations(
                type.params,
                shape.jsonObject
                    .properties()
                    .getValue("params")
                    .jsonObject
                    .properties(),
            )
        }
    }

    @Test
    fun `catalog changes control accepted units required fields and generated text`() {
        val catalog = Stage1Catalog.catalog
        val changed =
            catalog.copy(
                types =
                    catalog.types.map { type ->
                        if (type.id != "client") {
                            type
                        } else {
                            type.copy(
                                params =
                                    type.params.map { param ->
                                        if (param.name == "deadline") param.copy(units = listOf(QuantityUnit("tick", 1.0, 1.0))) else param
                                    } + ParamDescriptor("burst", ParamKind.INTEGER, "Burst", "Burst size.", required = true, minimum = 2.0),
                            )
                        }
                    },
            )
        val schemas = DocumentSchemas(changed).generate()
        assertThat(schemas.getValue("model.schema.json")).isNotEqualTo(generated.getValue("model.schema.json"))
        val schema = factory.getSchema(schemas.getValue("model.schema.json"), InputFormat.JSON)
        val newUnits = model.replace("\"1s\"", "\"1000tick\"")
        assertThat(schema.validate(newUnits, InputFormat.JSON)).isNotEmpty()
        assertThat(schema.validate(newUnits.replace("\"1000tick\"", "\"1000tick\",\"burst\":2"), InputFormat.JSON)).isEmpty()
        assertThat(schema.validate(model.replace("\"1s\"", "\"1s\",\"burst\":2"), InputFormat.JSON)).isNotEmpty()
        assertThat(schemas).isEqualTo(DocumentSchemas(changed).generate())
    }

    private fun assertAnnotations(
        descriptors: List<ParamDescriptor>,
        properties: JsonObject,
    ) {
        descriptors.forEach { descriptor ->
            val property = properties.getValue(descriptor.name).jsonObject
            val value = property["anyOf"]?.jsonArray?.first()?.jsonObject ?: property
            if (descriptor.kind == ParamKind.QUANTITY) {
                val annotation = value.getValue("x-quantity").jsonObject
                assertThat(annotation["dimension"]).isEqualTo(JsonPrimitive(descriptor.dimension!!.name))
                assertThat(annotation["units"]).isEqualTo(Json.encodeToJsonElement(descriptor.units))
                assertThat(annotation["minimum"]).isEqualTo(descriptor.minimum?.let(::JsonPrimitive))
                assertThat(annotation["exclusiveMinimum"]).isEqualTo(descriptor.exclusiveMinimum?.let(::JsonPrimitive))
                assertThat(annotation["maximum"]).isEqualTo(descriptor.maximum?.let(::JsonPrimitive))
                assertThat(property.getValue("description").toString()).contains("Canonical value", "checked by the core")
            }
            if (descriptor.kind == ParamKind.OBJECT) assertAnnotations(descriptor.fields, value.properties())
            if (descriptor.kind == ParamKind.ARRAY) {
                val items = value.getValue("items").jsonObject
                if (descriptor.options.isEmpty()) {
                    assertAnnotations(descriptor.fields, items.properties())
                } else {
                    assertThat(items["enum"]).isEqualTo(JsonArray(descriptor.options.map(::JsonPrimitive)))
                }
            }
        }
    }

    private fun JsonObject.properties(): JsonObject = getValue("properties").jsonObject

    private fun validate(
        kind: String,
        text: String,
    ) = factory.getSchema(generated.getValue("$kind.schema.json"), InputFormat.JSON).validate(text, InputFormat.JSON)

    private fun experiment(overrides: String = "{}") =
        """{"schemaVersion":3,"modelRef":"missing.model.json","execution":{"replications":1,"seed":0,"warmup":"0ms","measurement":"1s"},"variants":[{"id":"baseline","overrides":$overrides}]}"""

    private val model =
        """{"schemaVersion":6,"blocks":{"c":{"type":"client","params":{"load": {"points": [{"time": "0s", "rate": "120/s"}]},"deadline":"1s"}},"s":{"type":"service","params":{"handlers":2,"processing":{"kind":"fixed","mean":"0ms"}}}},"connections":[]}"""
}
