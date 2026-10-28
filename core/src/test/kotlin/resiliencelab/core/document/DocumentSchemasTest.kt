package resiliencelab.core.document

import com.networknt.schema.InputFormat
import com.networknt.schema.JsonSchemaFactory
import com.networknt.schema.SchemaLocation
import com.networknt.schema.SpecVersion.VersionFlag
import kotlinx.serialization.json.Json
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
    private val root = Path.of(System.getProperty("resilience-lab.project-root"))
    private val factory = JsonSchemaFactory.getInstance(VersionFlag.V202012)
    private val generated = DocumentSchemas().generate()

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
                model.replace("\"rate\":\"120/s\",", ""),
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
                model.replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"extra\":1"),
                model.replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
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
                                        if (param.name == "rate") param.copy(units = listOf(QuantityUnit("rps", 1.0, 1_000.0))) else param
                                    } + ParamDescriptor("burst", ParamKind.INTEGER, "Burst", "Burst size.", required = true, minimum = 2.0),
                            )
                        }
                    },
            )
        val schemas = DocumentSchemas(changed).generate()
        assertThat(schemas.getValue("model.schema.json")).isNotEqualTo(generated.getValue("model.schema.json"))
        val schema = factory.getSchema(schemas.getValue("model.schema.json"), InputFormat.JSON)
        val newUnits = model.replace("\"120/s\"", "\"120rps\"")
        assertThat(schema.validate(newUnits, InputFormat.JSON)).isNotEmpty()
        assertThat(schema.validate(newUnits.replace("\"120rps\"", "\"120rps\",\"burst\":2"), InputFormat.JSON)).isEmpty()
        assertThat(schema.validate(model.replace("\"120/s\"", "\"120/s\",\"burst\":2"), InputFormat.JSON)).isNotEmpty()
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
        }
    }

    private fun JsonObject.properties(): JsonObject = getValue("properties").jsonObject

    private fun validate(
        kind: String,
        text: String,
    ) = factory.getSchema(generated.getValue("$kind.schema.json"), InputFormat.JSON).validate(text, InputFormat.JSON)

    private fun experiment(overrides: String = "{}") =
        """{"schemaVersion":1,"modelRef":"missing.model.json","execution":{"replications":1,"seed":0,"warmup":"0ms","measurement":"1s"},"variants":[{"id":"baseline","overrides":$overrides}]}"""

    private val model =
        """{"schemaVersion":1,"blocks":{"c":{"type":"client","params":{"rate":"120/s","deadline":"1s"}},"s":{"type":"service","params":{"handlers":2,"processing":{"kind":"fixed","mean":"0ms"}}}},"connections":[]}"""
}
