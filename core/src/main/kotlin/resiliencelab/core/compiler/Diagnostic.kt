package resiliencelab.core.compiler

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/** Severity of a diagnostic; only errors block a run. */
@Serializable
enum class Severity {
    ERROR,
    WARNING,
    ADVICE,
}

/**
 * One finding shared by API, CLI and UI: a stable [code], the [document] and JSON [pointer] it refers to,
 * and the block [path] when it concerns a block or connection (stage 1 design §4.1).
 */
@Serializable
data class Diagnostic(
    val code: String,
    val severity: Severity,
    val message: String,
    val document: String? = null,
    val pointer: String? = null,
    val path: String? = null,
    /** Variant ID for a variant-specific finding; null for model-wide or common findings. */
    val variant: String? = null,
    /** Unformatted string and number values for the message identified by [code]; absent in older artifacts. */
    val args: Map<String, JsonPrimitive>? = null,
) {
    internal constructor(
        code: CoreMessage,
        severity: Severity,
        message: String,
        document: String? = null,
        pointer: String? = null,
        path: String? = null,
        variant: String? = null,
        args: Map<String, JsonPrimitive> = emptyMap(),
    ) : this(code.code, severity, message, document, pointer, path, variant, code.args(args))
}

/** JSON Pointer construction (RFC 6901). */
object JsonPointer {
    fun of(vararg tokens: Any): String = tokens.joinToString(separator = "") { "/" + escape(it.toString()) }

    fun child(
        base: String,
        token: Any,
    ): String = base + "/" + escape(token.toString())

    private fun escape(token: String): String = token.replace("~", "~0").replace("/", "~1")
}

/** Mutable collector used while compiling. */
class Diagnostics {
    val items: MutableList<Diagnostic> = mutableListOf()

    fun error(
        code: String,
        message: String,
        document: String?,
        pointer: String? = null,
        path: String? = null,
        variant: String? = null,
        args: Map<String, JsonPrimitive>? = null,
    ) {
        items += Diagnostic(code, Severity.ERROR, message, document, pointer, path, variant, args)
    }

    internal fun error(
        code: CoreMessage,
        message: String,
        document: String?,
        pointer: String? = null,
        path: String? = null,
        variant: String? = null,
        args: Map<String, JsonPrimitive> = emptyMap(),
    ) {
        error(code.code, message, document, pointer, path, variant, code.args(args))
    }

    fun errorCount(): Int = items.count { it.severity == Severity.ERROR }
}
