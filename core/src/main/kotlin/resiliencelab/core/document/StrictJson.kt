package resiliencelab.core.document

import com.fasterxml.jackson.core.JsonFactory
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.core.JsonProcessingException
import com.fasterxml.jackson.core.JsonToken
import com.fasterxml.jackson.core.StreamReadFeature
import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.CoreMessage
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
                                code = CoreMessage.JSON_NON_FINITE,
                                severity = Severity.ERROR,
                                message = "Number at line ${parser.currentLocation().lineNr} is not finite",
                                document = document,
                                args = mapOf("line" to JsonPrimitive(parser.currentLocation().lineNr)),
                            )
                    }
                }
                problem
            }
        } catch (exception: JsonProcessingException) {
            val duplicate = exception.originalMessage.startsWith("Duplicate field")
            val location = exception.location
            val key = (exception.processor as? JsonParser)?.currentName()
            val code =
                if (duplicate) {
                    if (location != null && key != null) CoreMessage.JSON_DUPLICATE_KEY else CoreMessage.JSON_DUPLICATE_DETAIL
                } else {
                    if (location != null) CoreMessage.JSON_SYNTAX else CoreMessage.JSON_SYNTAX_DETAIL
                }
            val args =
                if (duplicate && location != null && key != null) {
                    mapOf(
                        "key" to JsonPrimitive(key),
                        "line" to JsonPrimitive(location.lineNr),
                        "column" to JsonPrimitive(location.columnNr),
                    )
                } else {
                    buildMap {
                        put("detail", JsonPrimitive(exception.originalMessage))
                        if (!duplicate && location != null) {
                            put("line", JsonPrimitive(location.lineNr))
                            put("column", JsonPrimitive(location.columnNr))
                        }
                    }
                }
            Diagnostic(
                code = code,
                severity = Severity.ERROR,
                message = "${exception.originalMessage} at line ${exception.location?.lineNr}, column ${exception.location?.columnNr}",
                document = document,
                args = args,
            )
        }
}
