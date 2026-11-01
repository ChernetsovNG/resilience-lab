package resiliencelab.core.engine.ksl

import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.Severity
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.ServiceStep
import resiliencelab.core.ir.walk

/** Cache execution awaits T2.2; reject before allocating run artifacts. */
internal fun GraphIr.requireSupportedExecution() {
    if (services.any { node ->
            node.type == "cache" ||
                scenario(node).walk().any {
                    it is ServiceStep.CacheRead
                }
        } ||
        faults.any { it.kind == FaultKind.FLUSH }
    ) {
        throw ExperimentExecutionException(
            CoreMessage.EXECUTION_UNSUPPORTED_SCENARIO,
            CoreMessage.EXECUTION_UNSUPPORTED_SCENARIO.template,
        )
    }
}

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
