package resiliencelab.core.document

import com.fasterxml.jackson.core.JsonFactory
import com.fasterxml.jackson.core.JsonProcessingException
import com.fasterxml.jackson.core.JsonToken
import com.fasterxml.jackson.core.StreamReadFeature
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.Severity

/** Rejects what kotlinx would silently accept: duplicate keys and non-finite numbers (ADR 0005, item 7). */
object StrictJson {
    private val factory: JsonFactory =
        JsonFactory
            .builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build()

    /** Returns a diagnostic for the first problem in [text], or null when the text is acceptable. */
    fun check(
        text: String,
        document: String,
    ): Diagnostic? =
        try {
            factory.createParser(text).use { parser ->
                var problem: Diagnostic? = null
                while (problem == null) {
                    val token = parser.nextToken() ?: break
                    if (token == JsonToken.VALUE_NUMBER_FLOAT && !parser.doubleValue.isFinite()) {
                        problem =
                            Diagnostic(
                                code = "JSON_NON_FINITE",
                                severity = Severity.ERROR,
                                message = "Number at line ${parser.currentLocation().lineNr} is not finite",
                                document = document,
                            )
                    }
                }
                problem
            }
        } catch (exception: JsonProcessingException) {
            val code = if (exception.originalMessage.startsWith("Duplicate field")) "JSON_DUPLICATE_KEY" else "JSON_SYNTAX"
            Diagnostic(
                code = code,
                severity = Severity.ERROR,
                message = "${exception.originalMessage} at line ${exception.location?.lineNr}, column ${exception.location?.columnNr}",
                document = document,
            )
        }
}
