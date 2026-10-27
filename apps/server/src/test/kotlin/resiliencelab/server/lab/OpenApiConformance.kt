package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.assertj.core.api.Assertions.assertThat
import org.springframework.mock.web.MockHttpServletResponse

/**
 * Checks responses against the generated OpenAPI document with the JSON Schema rules the API uses: `$ref`,
 * `oneOf`/`anyOf`, `type` (also as a list), `enum` including `null`, `required`, `properties`, `additionalProperties`
 * and `items`. Guards the agreement between kotlinx, which writes the JSON, and springdoc, which derives the schema.
 */
class OpenApiConformance(
    document: String,
) {
    private val root = Json.parseToJsonElement(document).jsonObject
    private val schemas =
        root
            .getValue("components")
            .jsonObject
            .getValue("schemas")
            .jsonObject

    fun assertResponse(
        method: String,
        path: String,
        response: MockHttpServletResponse,
    ) {
        val operation =
            root
                .getValue("paths")
                .jsonObject
                .getValue(path)
                .jsonObject
                .getValue(method)
                .jsonObject
        val documented = operation.getValue("responses").jsonObject[response.status.toString()]?.jsonObject
        assertThat(documented).describedAs("$method $path ${response.status} is not documented").isNotNull()
        val schema =
            documented!!
                .getValue("content")
                .jsonObject
                .getValue("application/json")
                .jsonObject
                .getValue("schema")
                .jsonObject
        check(schema, Json.parseToJsonElement(response.getContentAsString(Charsets.UTF_8)), "$method $path ${response.status}")
    }

    private fun check(
        schema: JsonObject,
        value: JsonElement,
        at: String,
    ) {
        (schema["\$ref"] as? JsonPrimitive)?.let { reference ->
            return check(schemas.getValue(reference.content.substringAfterLast('/')).jsonObject, value, at)
        }
        ((schema["oneOf"] ?: schema["anyOf"]) as? JsonArray)?.let { alternatives ->
            val matching = alternatives.count { runCatching { check(it.jsonObject, value, at) }.isSuccess }
            assertThat(matching).describedAs("$at: $value matches none of the alternatives").isPositive()
            return
        }
        val types =
            when (val type = schema["type"]) {
                is JsonPrimitive -> setOf(type.content)
                is JsonArray -> type.map { it.jsonPrimitive.content }.toSet()
                else -> null
            }
        if (types != null) {
            val actual = typeOf(value)
            assertThat(actual in types || (actual == "integer" && "number" in types))
                .describedAs("$at: $actual is not one of $types")
                .isTrue()
        }
        (schema["enum"] as? JsonArray)?.let { values -> assertThat(values).describedAs("$at: $value is not in the enum").contains(value) }
        when (value) {
            is JsonObject -> checkObject(schema, value, at)
            is JsonArray -> {
                val items = schema["items"] as? JsonObject
                if (items != null) value.forEachIndexed { index, item -> check(items, item, "$at[$index]") }
            }
            else -> Unit
        }
    }

    private fun checkObject(
        schema: JsonObject,
        value: JsonObject,
        at: String,
    ) {
        val properties = schema["properties"]?.jsonObject ?: JsonObject(emptyMap())
        val required = schema["required"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        assertThat(value.keys).describedAs("$at: missing required properties").containsAll(required)
        val additional = schema["additionalProperties"]
        value.forEach { (name, item) ->
            val property = properties[name] as? JsonObject
            when {
                property != null -> check(property, item, "$at.$name")
                additional is JsonObject -> check(additional, item, "$at.$name")
                else -> assertThat(additional).describedAs("$at.$name is not declared").isEqualTo(JsonPrimitive(true))
            }
        }
    }

    private fun typeOf(value: JsonElement): String =
        when (value) {
            JsonNull -> "null"
            is JsonObject -> "object"
            is JsonArray -> "array"
            is JsonPrimitive ->
                when {
                    value.isString -> "string"
                    value.booleanOrNull != null -> "boolean"
                    value.longOrNull != null -> "integer"
                    else -> "number"
                }
        }
}
