package resiliencelab.core.document

import kotlinx.schema.generator.json.serialization.SerializationClassJsonSchemaGenerator
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Dimension
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.ParamKind
import resiliencelab.core.catalog.Quantities
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.catalog.TypeCategory
import resiliencelab.core.compiler.ModelCompiler

/**
 * Draft 2020-12 schemas derived from document serializers and the catalog (ADR 0005, item 8).
 * Numeric bounds of string quantities are annotations in canonical units under `x-quantity`; the core checks them.
 * References, topology and path-dependent override values remain the compiler's responsibility.
 */
class DocumentSchemas(
    private val catalog: Catalog = Stage1Catalog.catalog,
) {
    private val generator = SerializationClassJsonSchemaGenerator()

    /** Canonical UTF-8 document text keyed by its filename in the repository's `schemas/` directory. */
    fun generate(): Map<String, String> =
        linkedMapOf(
            "model.schema.json" to model(),
            "layout.schema.json" to structural(LayoutFile.serializer()),
            "experiment.schema.json" to experiment(),
        ).mapValues { (name, schema) ->
            val identified =
                JsonObject(schema + ("\$id" to JsonPrimitive("https://github.com/ChernetsovNG/resilience-lab/schemas/$name")))
            DocumentCodec.encode(JsonObject.serializer(), identified)
        }

    private fun structural(serializer: KSerializer<*>): JsonObject =
        numericStrings(
            Json
                .parseToJsonElement(generator.generateSchemaString(serializer.descriptor))
                .jsonObject
                .properties(
                    "schemaVersion" to
                        buildJsonObject {
                            put("type", "integer")
                            put("const", DocumentCodec.SCHEMA_VERSION)
                        },
                ),
        ).jsonObject

    // kotlinx accepts quoted numbers in typed document fields. Catalog values use JsonElement and reject them.
    private fun numericStrings(element: JsonElement): JsonElement =
        when (element) {
            is JsonArray -> JsonArray(element.map(::numericStrings))
            is JsonObject -> {
                val schema = JsonObject(element.mapValues { (_, value) -> numericStrings(value) })
                val types = schema["type"].let { if (it is JsonArray) it else listOf(it) }
                if (types.any { it == JsonPrimitive("number") || it == JsonPrimitive("integer") }) {
                    buildJsonObject {
                        put(
                            "anyOf",
                            JsonArray(
                                listOf(
                                    schema,
                                    buildJsonObject {
                                        put("type", "string")
                                        put(
                                            "description",
                                            "Quoted numeric literals are parsed and range-checked by the document decoder and core.",
                                        )
                                    },
                                ),
                            ),
                        )
                    }
                } else {
                    schema
                }
            }
            else -> element
        }

    private fun model(): JsonObject {
        val schema = structural(ModelFile.serializer())
        val definitions = schema.getValue("\$defs").jsonObject.toMutableMap()
        listOf("BlockInstance" to TypeCategory.BLOCK, "ConnectionInstance" to TypeCategory.CONNECTION).forEach { (name, category) ->
            val key = "resiliencelab.core.document.$name"
            val shape = definitions.getValue(key).jsonObject
            val alternatives =
                catalog.types.filter { it.category == category }.sortedBy { it.id }.map { type ->
                    val specialized =
                        shape.properties(
                            "type" to buildJsonObject { put("const", type.id) },
                            "params" to parameters(type.params),
                        )
                    buildJsonObject {
                        specialized.forEach { (key, value) -> put(key, value) }
                        put("title", type.title)
                        put("description", type.description)
                        if (type.params.any { it.required }) {
                            put("required", JsonArray(shape.getValue("required").jsonArray + JsonPrimitive("params")))
                        }
                    }
                }
            definitions[key] = buildJsonObject { put("oneOf", JsonArray(alternatives)) }
        }
        return JsonObject(schema + ("\$defs" to JsonObject(definitions)))
    }

    private fun parameters(descriptors: List<ParamDescriptor>): JsonObject =
        buildJsonObject {
            put("type", "object")
            put("properties", JsonObject(descriptors.sortedBy { it.name }.associate { it.name to parameter(it) }))
            put("additionalProperties", false)
            put("required", JsonArray(descriptors.filter { it.required }.map { JsonPrimitive(it.name) }.sortedBy { it.content }))
        }

    private fun parameter(descriptor: ParamDescriptor): JsonObject {
        val value =
            when (descriptor.kind) {
                ParamKind.INTEGER, ParamKind.NUMBER ->
                    buildJsonObject {
                        put("type", if (descriptor.kind == ParamKind.INTEGER) "integer" else "number")
                        bounds(descriptor).forEach { (key, value) -> put(key, value) }
                    }
                ParamKind.CHOICE ->
                    buildJsonObject {
                        put("type", "string")
                        put("enum", JsonArray(descriptor.options.map(::JsonPrimitive)))
                    }
                ParamKind.OBJECT -> parameters(descriptor.fields)
                ParamKind.QUANTITY -> quantity(descriptor)
            }
        return buildJsonObject {
            if (descriptor.required) {
                value.forEach { (key, value) -> put(key, value) }
            } else {
                // ParamReader treats explicit null like omission, including parameters with catalog defaults.
                put("anyOf", JsonArray(listOf(value, buildJsonObject { put("type", "null") })))
            }
            put("title", descriptor.title)
            put("description", descriptor.description + quantityRange(descriptor))
            descriptor.default?.let { put("default", it) }
        }
    }

    private fun quantity(descriptor: ParamDescriptor): JsonObject =
        buildJsonObject {
            put("type", "string")
            val symbols =
                descriptor.units.joinToString("|") { unit ->
                    unit.symbol.map { if (it in "\\.^$|?*+()[]{}") "\\$it" else "$it" }.joinToString("")
                }
            put("pattern", "^[0-9]+(?:\\.[0-9]+)?(?:[eE][-+]?[0-9]+)?(?:$symbols)$")
            put(
                "x-quantity",
                buildJsonObject {
                    put("dimension", requireNotNull(descriptor.dimension).name)
                    put("units", Json.encodeToJsonElement(descriptor.units))
                    bounds(descriptor).forEach { (key, value) -> put(key, value) }
                },
            )
        }

    private fun bounds(descriptor: ParamDescriptor): JsonObject =
        buildJsonObject {
            descriptor.minimum?.let { put("minimum", it) }
            descriptor.exclusiveMinimum?.let { put("exclusiveMinimum", it) }
            descriptor.maximum?.let { put("maximum", it) }
        }

    private fun quantityRange(descriptor: ParamDescriptor): String {
        if (descriptor.kind != ParamKind.QUANTITY) return ""
        val range =
            listOfNotNull(
                descriptor.minimum?.let { ">= ${Quantities.plain(it)}" },
                descriptor.exclusiveMinimum?.let { "> ${Quantities.plain(it)}" },
                descriptor.maximum?.let { "<= ${Quantities.plain(it)}" },
            ).joinToString(" and ")
        val canonical =
            when (descriptor.dimension) {
                Dimension.DURATION -> "milliseconds"
                Dimension.RATE -> "requests per millisecond"
                Dimension.PROBABILITY -> "probability from 0 to 1"
                null -> error("Quantity '${descriptor.name}' has no dimension")
            }
        return " Units: ${descriptor.units.joinToString { it.symbol }}. " +
            "Canonical value ($canonical): ${range.ifEmpty { "non-negative" }}; numeric bounds are checked by the core."
    }

    private fun experiment(): JsonObject {
        val schema = structural(ExperimentFile.serializer())
        val definitions = schema.getValue("\$defs").jsonObject.toMutableMap()
        val execution = "resiliencelab.core.document.ExecutionSettings"
        definitions[execution] =
            definitions.getValue(execution).jsonObject.properties(
                "replications" to
                    numericStrings(
                        buildJsonObject {
                            put("type", "integer")
                            put("minimum", 1)
                        },
                    ),
                "seed" to
                    numericStrings(
                        buildJsonObject {
                            put("type", "integer")
                            put("minimum", 0)
                            put("maximum", ModelCompiler.MAX_SEED)
                        },
                    ),
                "warmup" to duration("warmup", allowZero = true),
                "measurement" to duration("measurement"),
                "maxRealTime" to duration("maxRealTime"),
                "window" to duration("window", required = false),
            )
        val fault = "resiliencelab.core.document.Fault"
        definitions[fault] =
            definitions.getValue(fault).jsonObject.properties(
                "from" to duration("from", allowZero = true),
                "to" to duration("to"),
                "failureRate" to
                    parameter(
                        ParamDescriptor(
                            "failureRate",
                            ParamKind.QUANTITY,
                            "Failure rate",
                            "Probability of a failed attempt.",
                            dimension = Dimension.PROBABILITY,
                            units = Quantities.unitsOf(Dimension.PROBABILITY),
                            minimum = 0.0,
                            maximum = 1.0,
                        ),
                    ),
                "processingMultiplier" to
                    numericStrings(
                        buildJsonObject {
                            put("type", JsonArray(listOf(JsonPrimitive("number"), JsonPrimitive("null"))))
                            put("exclusiveMinimum", 0)
                        },
                    ),
            )
        return JsonObject(schema + ("\$defs" to JsonObject(definitions)))
    }

    private fun duration(
        name: String,
        allowZero: Boolean = false,
        required: Boolean = true,
    ): JsonObject =
        parameter(
            ParamDescriptor(
                name,
                ParamKind.QUANTITY,
                name,
                "Simulation duration.",
                required = required,
                dimension = Dimension.DURATION,
                units = Quantities.unitsOf(Dimension.DURATION),
                minimum = if (allowZero) 0.0 else null,
                exclusiveMinimum = if (allowZero) null else 0.0,
            ),
        )

    private fun JsonObject.properties(vararg values: Pair<String, JsonElement>): JsonObject =
        JsonObject(this + ("properties" to JsonObject(getValue("properties").jsonObject + values)))
}
