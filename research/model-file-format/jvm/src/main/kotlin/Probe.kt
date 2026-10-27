@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package resiliencelab.research

import com.charleskorn.kaml.PolymorphismStyle
import com.charleskorn.kaml.Yaml
import com.charleskorn.kaml.YamlConfiguration
import com.fasterxml.jackson.core.JsonFactory
import com.fasterxml.jackson.core.StreamReadFeature
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.databind.json.JsonMapper
import com.fasterxml.jackson.module.kotlin.KotlinModule
import com.fasterxml.jackson.module.kotlin.readValue
import com.github.victools.jsonschema.generator.OptionPreset
import com.github.victools.jsonschema.generator.SchemaGenerator
import com.github.victools.jsonschema.generator.SchemaGeneratorConfigBuilder
import com.github.victools.jsonschema.generator.SchemaVersion
import com.github.victools.jsonschema.module.jackson.JacksonModule
import kotlinx.schema.generator.json.serialization.SerializationClassJsonSchemaGenerator
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.assertj.core.api.Assertions.assertThat
import org.snakeyaml.engine.v2.api.*
import org.snakeyaml.engine.v2.api.lowlevel.*
import org.snakeyaml.engine.v2.common.FlowStyle
import org.snakeyaml.engine.v2.nodes.*
import org.snakeyaml.engine.v2.schema.JsonSchema as YamlJsonSchema
import java.io.File
import kotlin.system.measureNanoTime

@Serializable enum class Mode { @SerialName("sync") SYNC, @SerialName("async") ASYNC }
@Serializable sealed interface Work
@Serializable @SerialName("fixed") data class Fixed(val ms: Double) : Work
@Serializable @SerialName("uniform") data class Uniform(val low: Double, val high: Double) : Work
@Serializable data class ProbeModel(
    @SerialName("schemaVersion") val version: Int,
    val requiredNullable: String?,
    val name: String = "untitled",
    val note: String? = null,
    val mode: Mode = Mode.SYNC,
    val work: Work = Fixed(10.0),
)
@Serializable data class NumberModel(val value: Double)
@Serializable data class Block(val id: String, val type: String, val timeoutMs: Int)
@Serializable data class LargeModel(val schemaVersion: Int = 1, val blocks: List<Block>)

private val out = File("results").also { it.mkdirs() }
private val results = linkedMapOf<String, JsonElement>()
private val json = Json { prettyPrint = true; prettyPrintIndent = "  "; encodeDefaults = true }
private val yaml = Yaml(configuration = YamlConfiguration(polymorphismStyle = PolymorphismStyle.Property))
private val mapper = JsonMapper.builder(JsonFactory.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
    .addModule(KotlinModule.Builder().build())
    .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
    .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
    .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
    .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
    .build()
private val loadSettings = LoadSettings.builder().setSchema(YamlJsonSchema()).setAllowDuplicateKeys(false)
    .setAllowNonScalarKeys(false).setMaxAliasesForCollections(0).setParseComments(true).build()
private val dumpSettings = DumpSettings.builder().setSchema(YamlJsonSchema()).setDefaultFlowStyle(FlowStyle.BLOCK)
    .setIndent(2).setBestLineBreak("\n").setSplitLines(false).setDumpComments(true).build()

private fun record(name: String, value: Any?) {
    results[name] = when(value) { is Boolean -> JsonPrimitive(value); is Number -> JsonPrimitive(value); else -> JsonPrimitive(value.toString()) }
}
private fun rejects(name: String, block: () -> Unit): Boolean {
    val failure = runCatching(block).exceptionOrNull()
    record(name, if (failure == null) "ACCEPTED" else "REJECTED: ${failure.javaClass.simpleName}")
    return failure != null
}
private fun emit(node: Node) = Present(dumpSettings).emitToString(Serialize(dumpSettings).serializeOne(node).iterator())

/** Standalone research assertions; never loaded by application modules. */
fun main(args: Array<String>) {
    if (args.contains("--benchmark")) { benchmark(); return }
    record("java", System.getProperty("java.version")); record("kotlin", KotlinVersion.CURRENT)
    val fixture = ProbeModel(1, null)
    val text = json.encodeToString(fixture)
    assertThat(json.decodeFromString<ProbeModel>(text)).isEqualTo(fixture)
    assertThat(json.encodeToString(json.decodeFromString<ProbeModel>(text))).isEqualTo(text)
    record("kotlinx.deterministicTypedRewrite", true)
    assertThat(rejects("kotlinx.unknown", { json.decodeFromString<ProbeModel>(text.dropLast(1) + ",\"oops\":1}") })).isTrue()
    assertThat(rejects("kotlinx.nan", { json.decodeFromString<NumberModel>("{\"value\":NaN}") })).isTrue()
    assertThat(rejects("kotlinx.infinity", { json.decodeFromString<NumberModel>("{\"value\":1e999}") })).isTrue()
    assertThat(rejects("kotlinx.encodeNaN", { json.encodeToString(NumberModel(Double.NaN)) })).isTrue()
    record("kotlinx.treeNaN", json.parseToJsonElement("{\"value\":NaN}").toString())
    record("kotlinx.quotedNumber", json.decodeFromString<NumberModel>("{\"value\":\"1.0\"}").value)
    assertThat(rejects("kotlinx.trailingComma", { json.parseToJsonElement("{\"x\":1,}") })).isTrue()
    val duplicate = "{\"value\":1,\"value\":2}"
    record("kotlinx.duplicates", json.decodeFromString<NumberModel>(duplicate).value)
    assertThat(json.decodeFromString<NumberModel>(duplicate).value).isEqualTo(2.0)
    assertThat(rejects("jackson.duplicates", { mapper.readValue<NumberModel>(duplicate) })).isTrue()
    assertThat(rejects("jackson.unknown", { mapper.readValue<NumberModel>("{\"value\":1,\"oops\":1}") })).isTrue()
    assertThat(rejects("jackson.nan", { mapper.readValue<NumberModel>("{\"value\":NaN}") })).isTrue()
    // Valid JSON exponent overflow becomes infinity in Jackson's Double binding; finite validation is separate.
    record("jackson.exponentOverflowFinite", mapper.readValue<NumberModel>("{\"value\":1e999}").value.isFinite())
    record("jackson.encodeNaN", mapper.writeValueAsString(NumberModel(Double.NaN)))
    val mapA = linkedMapOf("z" to 1, "a" to 2); val mapB = linkedMapOf("a" to 2, "z" to 1)
    record("kotlinx.mapInsertionOrderMatters", json.encodeToString(mapA) != json.encodeToString(mapB))
    assertThat(mapper.writeValueAsString(mapA)).isEqualTo(mapper.writeValueAsString(mapB))
    record("jackson.sortedMapsDeterministic", true)

    val yamlText = "# document note\nvalue: 1 # inline note\n# ending note\n"
    val kamlValue = yaml.decodeFromString(NumberModel.serializer(), yamlText)
    val kamlRewritten = yaml.encodeToString(NumberModel.serializer(), kamlValue.copy(value = 2.0))
    assertThat(kamlRewritten).doesNotContain("note")
    out.resolve("kaml-rewritten.yaml").writeText(kamlRewritten)
    record("kaml.typedRewriteRetainsComments", false)
    assertThat(rejects("kaml.unknown", { yaml.decodeFromString(NumberModel.serializer(), "value: 1\noops: 1") })).isTrue()
    assertThat(rejects("kaml.duplicates", { yaml.decodeFromString(NumberModel.serializer(), "value: 1\nvalue: 2") })).isTrue()
    record("kaml.nanRejected", rejects("kaml.nan", { yaml.decodeFromString(NumberModel.serializer(), "value: NaN") }))
    assertThat(yaml.decodeFromString(ProbeModel.serializer(), yaml.encodeToString(ProbeModel.serializer(), fixture))).isEqualTo(fixture)
    record("kaml.typedPolymorphicRoundTrip", true)

    val loaded = Load(loadSettings).loadFromString(yamlText)
    val rebuilt = Dump(dumpSettings).dumpToString(loaded)
    assertThat(rebuilt).doesNotContain("note")
    record("engine.loadDumpRetainsComments", false)
    val root = Compose(loadSettings).composeString(yamlText).orElseThrow() as MappingNode
    val tuple = root.value.single()
    val original = tuple.valueNode as ScalarNode
    val replacement = ScalarNode(original.tag, "2", original.scalarStyle)
    replacement.blockComments = original.blockComments
    replacement.inLineComments = original.inLineComments
    replacement.endComments = original.endComments
    root.value[0] = NodeTuple(tuple.keyNode, replacement)
    val edited = emit(root)
    assertThat(edited).contains("document note", "inline note", "ending note", "value: 2")
    assertThat(emit(Compose(loadSettings).composeString(edited).orElseThrow())).isEqualTo(edited)
    out.resolve("engine-node-edited.yaml").writeText(edited)
    record("engine.nodeEditRetainsComments", true)
    record("engine.stableSecondRewrite", true)
    assertThat(rejects("engine.duplicates", { Load(loadSettings).loadFromString("x: 1\nx: 2") })).isTrue()
    val engineNaN = (Load(loadSettings).loadFromString("value: .nan") as Map<*, *>)["value"]
    record("engine.jsonSchemaNanType", engineNaN!!::class.simpleName)
    assertThat((engineNaN as Double).isFinite()).isFalse()
    record("engine.jsonSchemaNanFinite", false)
    record("engine.composeDuplicateEntries", (Compose(loadSettings).composeString("x: 1\nx: 2").orElseThrow() as MappingNode).value.size)
    assertThat(rejects("engine.customTag", { Load(loadSettings).loadFromString("value: !Custom something") })).isTrue()
    assertThat(rejects("engine.nonScalarKey", { Load(loadSettings).loadFromString("? [x, y]\n: z") })).isTrue()
    assertThat(rejects("engine.multipleDocuments", { Load(loadSettings).loadFromString("x: 1\n---\nx: 2") })).isTrue()

    val schemaJson = Json { prettyPrint = true; prettyPrintIndent = "  "; explicitNulls = false }
    val generator = SerializationClassJsonSchemaGenerator(json = schemaJson)
    val schemaText = generator.generateSchemaString(ProbeModel.serializer().descriptor)
    val schema = json.parseToJsonElement(schemaText).jsonObject
    out.resolve("probe.schema.json").writeText(schemaText + "\n")
    out.resolve("probe-good.json").writeText(text + "\n")
    out.resolve("probe-missing-required.json").writeText("{}\n")
    out.resolve("probe-invalid-enum.json").writeText(text.replace("\"sync\"", "\"INVALID\"") + "\n")
    out.resolve("probe-invalid-kind.json").writeText(text.replace("\"fixed\"", "\"INVALID\"") + "\n")
    assertThat(schema["required"]!!.jsonArray.map { it.jsonPrimitive.content }).containsExactlyInAnyOrder("schemaVersion", "requiredNullable")
    val properties = schema["properties"]!!.jsonObject
    assertThat(properties["name"]!!.jsonObject.containsKey("default")).isFalse()
    assertThat(properties["requiredNullable"]!!.jsonObject["type"]!!.jsonArray.map { it.jsonPrimitive.content }).containsExactly("string", "null")
    val definitions = schema["\$defs"]!!.jsonObject
    assertThat(definitions["resiliencelab.research.Mode"]!!.jsonObject["enum"]!!.jsonArray.map { it.jsonPrimitive.content }).containsExactly("sync", "async")
    assertThat(definitions["resiliencelab.research.Work"]!!.jsonObject["oneOf"]!!.jsonArray).hasSize(2)
    assertThat(definitions["fixed"]!!.jsonObject["properties"]!!.jsonObject["type"]!!.jsonObject["const"]!!.jsonPrimitive.content).isEqualTo("fixed")
    assertThat(schema["additionalProperties"]).isEqualTo(JsonPrimitive(false))
    assertThat(generator.generateSchemaString(ProbeModel.serializer().descriptor)).isEqualTo(schemaText)
    record("schema.serialNameNullableEnumPolymorphismDeterministic", true)
    record("schema.defaultPresenceKnownValueUnavailable", true)
    val explicitNullsFalse = Json { explicitNulls = false }
    val omitted = explicitNullsFalse.encodeToString(fixture)
    assertThat(omitted).doesNotContain("requiredNullable")
    assertThat(explicitNullsFalse.decodeFromString<ProbeModel>(omitted)).isEqualTo(fixture)
    out.resolve("probe-explicit-nulls-false.json").writeText(omitted + "\n")
    record("schema.explicitNullsFalseRequiresPolicy", true)
    val jacksonSchema = SchemaGenerator(SchemaGeneratorConfigBuilder(SchemaVersion.DRAFT_2020_12, OptionPreset.PLAIN_JSON).with(JacksonModule()).build()).generateSchema(ProbeModel::class.java)
    out.resolve("victools-jackson.schema.json").writeText(jacksonSchema.toPrettyString() + "\n")
    record("jackson.ignoresSerialName", mapper.writeValueAsString(fixture).contains("\"version\""))
    record("jackson.enumUsesKotlinName", mapper.writeValueAsString(Mode.SYNC))
    record("checks", "PASS")
    out.resolve("checks.json").writeText(json.encodeToString(JsonObject(results)) + "\n")
    println(json.encodeToString(JsonObject(results)))
}

/** Warmed in-process parse smoke benchmark, not JMH or a UI latency budget. */
private fun benchmark() {
    val rows = mutableListOf<JsonElement>()
    for (size in listOf(50, 500, 5000)) {
        val model = LargeModel(blocks = (1..size).map { Block("block-$it", "service", 1000) })
        val jsonText = json.encodeToString(model)
        val yamlText = yaml.encodeToString(LargeModel.serializer(), model)
        val cases = linkedMapOf<String, () -> Int>(
            "kotlinx-json-tree" to { json.parseToJsonElement(jsonText).jsonObject["blocks"]!!.jsonArray.size },
            "jackson-json-tree" to { mapper.readTree(jsonText)["blocks"].size() },
            "kaml-yaml-tree" to { (yaml.parseToYamlNode(yamlText) as com.charleskorn.kaml.YamlMap).entries.size },
            "engine-yaml-tree" to { (Load(loadSettings).loadFromString(yamlText) as Map<*, *>).size },
        )
        for ((name, parse) in cases) {
            repeat(20) { check(parse() > 0) }
            val times = (1..50).map { measureNanoTime { check(parse() > 0) } / 1e6 }.sorted()
            rows += buildJsonObject {
                put("parser", name); put("blocks", size); put("jsonBytes", jsonText.toByteArray().size); put("yamlBytes", yamlText.toByteArray().size)
                put("warmup", 20); put("iterations", 50); put("medianMs", (times[24] + times[25]) / 2); put("p95Ms", times[47]); put("minMs", times.first())
            }
        }
    }
    val report = buildJsonObject { put("java", System.getProperty("java.version")); put("processors", Runtime.getRuntime().availableProcessors()); put("results", JsonArray(rows)) }
    out.resolve("benchmark.json").writeText(json.encodeToString(report) + "\n")
    println(json.encodeToString(report))
}
