package resiliencelab.core.document

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.Severity

/** Outcome of decoding one document. */
sealed interface DecodeResult<out T> {
    data class Ok<T>(
        val value: T,
    ) : DecodeResult<T>

    data class Failed(
        val diagnostics: List<Diagnostic>,
    ) : DecodeResult<Nothing>
}

/** Strict reading and deterministic writing of workspace documents (ADR 0005, items 4 and 7). */
object DocumentCodec {
    const val SCHEMA_VERSION = 1
    const val MODEL_SCHEMA_VERSION = 3

    @OptIn(ExperimentalSerializationApi::class)
    private val reader =
        Json {
            ignoreUnknownKeys = false
            explicitNulls = false
        }

    @OptIn(ExperimentalSerializationApi::class)
    private val writer =
        Json {
            prettyPrint = true
            prettyPrintIndent = "  "
            explicitNulls = false
            encodeDefaults = false
        }

    fun decodeModel(
        text: String,
        document: String,
    ): DecodeResult<ModelFile> = decode(text, document, ModelFile.serializer(), MODEL_SCHEMA_VERSION)

    fun decodeLayout(
        text: String,
        document: String,
    ): DecodeResult<LayoutFile> = decode(text, document, LayoutFile.serializer())

    fun decodeExperiment(
        text: String,
        document: String,
    ): DecodeResult<ExperimentFile> = decode(text, document, ExperimentFile.serializer())

    fun encodeModel(file: ModelFile): String = encode(ModelFile.serializer(), file)

    fun encodeLayout(file: LayoutFile): String = encode(LayoutFile.serializer(), file)

    fun encodeExperiment(file: ExperimentFile): String = encode(ExperimentFile.serializer(), file)

    /** Canonical text: object keys sorted recursively, arrays in order, two-space indent, LF, final newline. */
    fun <T> encode(
        serializer: KSerializer<T>,
        value: T,
    ): String = writer.encodeToString(JsonElement.serializer(), canonical(writer.encodeToJsonElement(serializer, value))) + "\n"

    private fun canonical(element: JsonElement): JsonElement =
        when (element) {
            is JsonObject -> JsonObject(element.toSortedMap().mapValues { (_, value) -> canonical(value) })
            is JsonArray -> JsonArray(element.map(::canonical))
            else -> element
        }

    private fun <T> decode(
        text: String,
        document: String,
        serializer: KSerializer<T>,
        expectedVersion: Int = SCHEMA_VERSION,
    ): DecodeResult<T> {
        StrictJson.check(text, document)?.let { return DecodeResult.Failed(listOf(it)) }
        val value =
            try {
                val root = reader.parseToJsonElement(text) as? JsonObject
                val actualVersion = (root?.get("schemaVersion") as? JsonPrimitive)?.intOrNull
                if (actualVersion != null && actualVersion != expectedVersion) {
                    return DecodeResult.Failed(
                        listOf(
                            Diagnostic(
                                code = CoreMessage.SCHEMA_VERSION,
                                severity = Severity.ERROR,
                                message = "Unsupported schemaVersion $actualVersion; expected $expectedVersion",
                                document = document,
                                pointer = "/schemaVersion",
                                args = mapOf("actual" to JsonPrimitive(actualVersion), "expected" to JsonPrimitive(expectedVersion)),
                            ),
                        ),
                    )
                }
                reader.decodeFromString(serializer, text)
            } catch (exception: SerializationException) {
                return DecodeResult.Failed(listOf(shape(exception, document)))
            } catch (exception: IllegalArgumentException) {
                return DecodeResult.Failed(listOf(shape(exception, document)))
            }
        return DecodeResult.Ok(value)
    }

    private fun shape(
        exception: Exception,
        document: String,
    ) = Diagnostic(
        code = if (exception.message == null) CoreMessage.DOCUMENT_SHAPE else CoreMessage.DOCUMENT_SHAPE_DETAIL,
        severity = Severity.ERROR,
        message = exception.message ?: "Document does not match its schema",
        document = document,
        args = exception.message?.let { mapOf("detail" to JsonPrimitive(it)) }.orEmpty(),
    )
}
