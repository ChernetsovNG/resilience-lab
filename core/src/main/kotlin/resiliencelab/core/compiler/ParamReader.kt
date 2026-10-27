package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.Quantities

/** Where overridden values of one element come from: parameter path (`attempts`, `backoff.base`) → experiment pointer. */
internal class OverrideOrigins(
    val document: String,
    private val pointers: Map<String, String>,
) {
    /** Pointer of the override that set [parameter] or an object holding it; null when the value comes from the model. */
    fun pointerOf(parameter: String): String? =
        pointers[parameter]
            ?: pointers.entries
                .filter { (path, _) -> parameter.startsWith("$path.") }
                .maxByOrNull { (path, _) -> path.length }
                ?.value

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
            .forEach { key -> report("PARAM_UNKNOWN", "Unknown parameter '$key'", key) }
    }

    fun has(name: String): Boolean = params[name].let { it != null && it !is JsonNull }

    fun int(name: String): Int? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value =
            (element as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
                ?: return fail("PARAM_TYPE", name, "Parameter '$name' must be an integer")
        return value.takeIf { inRange(descriptor, value.toDouble()) }
    }

    fun number(name: String): Double? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value =
            (element as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
                ?: return fail("PARAM_TYPE", name, "Parameter '$name' must be a number")
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
                    "QUANTITY_INVALID",
                    name,
                    "Parameter '$name' must be a quantity with one of the units " +
                        Quantities.unitsOf(dimension).joinToString { it.symbol },
                )
        return value.takeIf { inRange(descriptor, value) }
    }

    fun choice(name: String): String? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val text = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
        return text?.takeIf { it in descriptor.options }
            ?: fail("PARAM_TYPE", name, "Parameter '$name' must be one of ${descriptor.options.joinToString()}")
    }

    fun obj(name: String): ParamReader? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value = element as? JsonObject ?: return fail("PARAM_TYPE", name, "Parameter '$name' must be an object")
        val childPointer = JsonPointer.child(pointer, name)
        return ParamReader(value, descriptor.fields, document, childPointer, path, diagnostics, overrides, "$prefix$name.")
    }

    /** Reports an error about parameter [name] and returns null. */
    fun <T> fail(
        code: String,
        name: String,
        message: String,
    ): T? {
        report(code, message, name)
        return null
    }

    private fun descriptor(name: String): ParamDescriptor = descriptors.first { it.name == name }

    private fun valueOf(descriptor: ParamDescriptor): JsonElement? {
        val explicit = params[descriptor.name]?.takeUnless { it is JsonNull }
        if (explicit != null) return explicit
        if (descriptor.required) report("PARAM_MISSING", "Required parameter '${descriptor.name}' is missing", descriptor.name)
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
            report("PARAM_RANGE", "Parameter '${descriptor.name}' is out of range: ${rangeText(descriptor)}", descriptor.name)
        }
        return !(below || above)
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
        code: String,
        message: String,
        name: String,
    ) {
        val override = overrides.pointerOf(prefix + name)
        diagnostics +=
            if (override == null) {
                Diagnostic(code, Severity.ERROR, message, document, JsonPointer.child(pointer, name), path)
            } else {
                Diagnostic(code, Severity.ERROR, message, overrides.document, override, path)
            }
    }
}
