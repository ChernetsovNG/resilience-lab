package resiliencelab.core.engine.ksl

import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.Severity

/** Indicates that execution or result collection failed, so no complete experiment result can be produced. */
class ExperimentExecutionException(
    message: String,
    cause: Throwable? = null,
    /** Structured, safe-to-display cause; absent for failures without a known message contract. */
    val diagnostic: Diagnostic? = null,
) : RuntimeException(message, cause) {
    internal constructor(
        code: CoreMessage,
        message: String,
        args: Map<String, JsonPrimitive> = emptyMap(),
    ) : this(message, diagnostic = Diagnostic(code, Severity.ERROR, message, args = args))
}
