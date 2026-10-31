package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import resiliencelab.core.catalog.Dimension
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.Quantities

/** Where overridden values of one element come from: parameter path (`attempts`, `backoff.base`) → experiment pointer. */
internal class OverrideOrigins(
    val document: String,
    val pointers: Map<String, String>,
    val variant: String? = null,
) {
    /**
     * Pointer of the override that set [parameter] or an object holding it; null when the value comes from the model.
     * Array descendants retain their indexed location within that override; grid origins stay at the grid value.
     */
    fun pointerOf(parameter: String): String? {
        pointers[parameter]?.let { return it }
        val origin =
            pointers.entries
                .filter { (path, _) -> parameter.startsWith("$path.") }
                .maxByOrNull { (path, _) -> path.length }
                ?: return null
        val suffix = parameter.removePrefix("${origin.key}.").split(".")
        return if (origin.value.startsWith("/grid/") || suffix.none { it.toIntOrNull() != null }) {
            origin.value
        } else {
            suffix.fold(origin.value) { pointer, field -> JsonPointer.child(pointer, field) }
        }
    }

    companion object {
        val NONE = OverrideOrigins("", emptyMap())
    }
}

/**
 * Reads document parameters against catalog descriptors. Every null result has a diagnostic, except optional
 * parameters without a default, which are simply absent. A diagnostic about a value set by a variant override points
 * to that override in the experiment, otherwise to the parameter in the model.
 */
internal class ParamReader(
    private val params: JsonObject,
    private val descriptors: List<ParamDescriptor>,
    private val document: String,
    private val pointer: String,
    private val path: String,
    private val diagnostics: MutableList<Diagnostic>,
    private val overrides: OverrideOrigins = OverrideOrigins.NONE,
    private val prefix: String = "",
) {
    init {
        params.keys
            .filter { key -> descriptors.none { it.name == key } }
            .sorted()
            .forEach { key -> report(CoreMessage.PARAM_UNKNOWN, "Unknown parameter '$key'", key) }
    }

    fun has(name: String): Boolean = params[name].let { it != null && it !is JsonNull }

    /** A catalog-described free string; identifiers receive their domain checks in the compiler. */
    fun string(name: String): String? {
        val element = valueOf(descriptor(name)) ?: return null
        return (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: fail(CoreMessage.PARAM_STRING, name, "Parameter '$name' must be a string")
    }

    fun int(name: String): Int? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value =
            (element as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
                ?: return fail(CoreMessage.PARAM_INTEGER, name, "Parameter '$name' must be an integer")
        return value.takeIf { inRange(descriptor, value.toDouble()) }
    }

    fun number(name: String): Double? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value =
            (element as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
                ?: return fail(CoreMessage.PARAM_NUMBER, name, "Parameter '$name' must be a number")
        return value.takeIf { inRange(descriptor, value) }
    }

    fun quantity(name: String): Double? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val dimension = requireNotNull(descriptor.dimension) { "Quantity '$name' has no dimension" }
        val text = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
        val value =
            text?.let { Quantities.parse(it, dimension) }
                ?: return fail(
                    CoreMessage.QUANTITY_INVALID,
                    name,
                    "Parameter '$name' must be a quantity with one of the units " +
                        Quantities.unitsOf(dimension).joinToString { it.symbol },
                    args = mapOf("units" to JsonPrimitive(Quantities.unitsOf(dimension).joinToString { it.symbol })),
                )
        return value.takeIf { inRange(descriptor, value) }
    }

    fun choice(name: String): String? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val text = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
        return text?.takeIf { it in descriptor.options }
            ?: fail(
                CoreMessage.PARAM_CHOICE,
                name,
                "Parameter '$name' must be one of ${descriptor.options.joinToString()}",
                args = mapOf("options" to JsonPrimitive(descriptor.options.joinToString())),
            )
    }

    fun obj(name: String): ParamReader? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value = element as? JsonObject ?: return fail(CoreMessage.PARAM_OBJECT, name, "Parameter '$name' must be an object")
        val childPointer = JsonPointer.child(pointer, name)
        return ParamReader(value, descriptor.fields, document, childPointer, path, diagnostics, overrides, "$prefix$name.")
    }

    /** Non-empty arrays of catalog-described objects; diagnostics retain each array index. */
    fun objects(name: String): List<ParamReader>? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val values =
            element as? JsonArray
                ?: return fail(CoreMessage.PARAM_ARRAY, name, "Parameter '$name' must be a non-empty array of objects")
        if (values.isEmpty() || values.any { it !is JsonObject }) {
            return fail(CoreMessage.PARAM_ARRAY, name, "Parameter '$name' must be a non-empty array of objects")
        }
        return values.mapIndexed { index, value ->
            ParamReader(
                value as JsonObject,
                descriptor.fields,
                document,
                JsonPointer.child(JsonPointer.child(pointer, name), index.toString()),
                path,
                diagnostics,
                overrides,
                "$prefix$name.$index.",
            )
        }
    }

    /**
     * Reports an error about parameter [name] and returns null. For a conditional rule, [dependsOn] names the
     * other parameter controlling it; a grid origin takes precedence over a model or variant origin.
     */
    fun <T> fail(
        code: CoreMessage,
        name: String,
        message: String,
        dependsOn: String? = null,
        args: Map<String, JsonPrimitive> = emptyMap(),
    ): T? {
        report(code, message, name, dependsOn, args)
        return null
    }

    private fun descriptor(name: String): ParamDescriptor = descriptors.first { it.name == name }

    private fun valueOf(descriptor: ParamDescriptor): JsonElement? {
        val explicit = params[descriptor.name]?.takeUnless { it is JsonNull }
        if (explicit != null) return explicit
        if (descriptor.required) report(CoreMessage.PARAM_MISSING, "Required parameter '${descriptor.name}' is missing", descriptor.name)
        return descriptor.default
    }

    private fun inRange(
        descriptor: ParamDescriptor,
        value: Double,
    ): Boolean {
        val below =
            descriptor.minimum?.let { value < it } == true ||
                descriptor.exclusiveMinimum?.let { value <= it } == true
        val above = descriptor.maximum?.let { value > it } == true
        if (below || above) {
            val unit = descriptor.dimension?.let { Quantities.unitsOf(it).first { unit -> unit.symbol == baseUnit(it) } }
            val minimum = descriptor.minimum ?: descriptor.exclusiveMinimum
            val reason =
                when {
                    minimum == null -> if (unit == null) CoreMessage.PARAM_MAXIMUM else CoreMessage.PARAM_MAXIMUM_UNIT
                    descriptor.maximum == null && descriptor.exclusiveMinimum != null ->
                        if (unit == null) CoreMessage.PARAM_EXCLUSIVE_MINIMUM else CoreMessage.PARAM_EXCLUSIVE_MINIMUM_UNIT
                    descriptor.maximum == null -> if (unit == null) CoreMessage.PARAM_MINIMUM else CoreMessage.PARAM_MINIMUM_UNIT
                    descriptor.exclusiveMinimum != null ->
                        if (unit == null) CoreMessage.PARAM_EXCLUSIVE_BETWEEN else CoreMessage.PARAM_EXCLUSIVE_BETWEEN_UNIT
                    else -> if (unit == null) CoreMessage.PARAM_BETWEEN else CoreMessage.PARAM_BETWEEN_UNIT
                }
            val args =
                buildMap {
                    minimum?.let { put("minimum", messageNumber(it * (unit?.denominator ?: 1.0) / (unit?.numerator ?: 1.0))) }
                    descriptor.maximum?.let { put("maximum", messageNumber(it * (unit?.denominator ?: 1.0) / (unit?.numerator ?: 1.0))) }
                    unit?.let { put("unit", JsonPrimitive(it.symbol)) }
                }
            report(reason, "Parameter '${descriptor.name}' is out of range: ${rangeText(descriptor)}", descriptor.name, args = args)
        }
        return !(below || above)
    }

    private fun baseUnit(dimension: Dimension): String =
        when (dimension) {
            Dimension.DURATION -> "ms"
            Dimension.RATE -> "/s"
            Dimension.PROBABILITY -> "%"
        }

    private fun rangeText(descriptor: ParamDescriptor): String =
        listOfNotNull(
            descriptor.minimum?.let { ">= ${shown(descriptor, it)}" },
            descriptor.exclusiveMinimum?.let { "> ${shown(descriptor, it)}" },
            descriptor.maximum?.let { "<= ${shown(descriptor, it)}" },
        ).joinToString(" and ")

    private fun shown(
        descriptor: ParamDescriptor,
        value: Double,
    ): String = descriptor.dimension?.let { Quantities.format(value, it) } ?: Quantities.plain(value)

    private fun report(
        code: CoreMessage,
        message: String,
        name: String,
        dependsOn: String? = null,
        args: Map<String, JsonPrimitive> = emptyMap(),
    ) {
        val messageArgs = mapOf("parameter" to JsonPrimitive(name)) + args
        val origins = listOfNotNull(overrides.pointerOf(prefix + name), dependsOn?.let { overrides.pointerOf(prefix + it) })
        val override = origins.firstOrNull { it.startsWith("/grid/") } ?: origins.firstOrNull()
        diagnostics +=
            if (override == null) {
                Diagnostic(code, Severity.ERROR, message, document, JsonPointer.child(pointer, name), path, args = messageArgs)
            } else {
                Diagnostic(code, Severity.ERROR, message, overrides.document, override, path, overrides.variant, messageArgs)
            }
    }
}
