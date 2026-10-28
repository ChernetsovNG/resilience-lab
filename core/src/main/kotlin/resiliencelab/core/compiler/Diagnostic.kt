package resiliencelab.core.compiler

import kotlinx.serialization.Serializable

/** Severity of a diagnostic; only errors block a run. */
@Serializable
enum class Severity {
    ERROR,
    WARNING,
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
)

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
    ) {
        items += Diagnostic(code, Severity.ERROR, message, document, pointer, path, variant)
    }

    fun errorCount(): Int = items.count { it.severity == Severity.ERROR }
}
