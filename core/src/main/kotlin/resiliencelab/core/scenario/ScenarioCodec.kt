package resiliencelab.core.scenario

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Encodes and decodes scenario, experiment, and sweep JSON without performing domain validation.
 * Experiment and sweep documents must declare the supported schema version; unknown JSON fields are rejected.
 */
object ScenarioCodec {
    private const val SUPPORTED_SCHEMA_VERSION = 1

    private val json =
        Json {
            ignoreUnknownKeys = false
            explicitNulls = false
            prettyPrint = true
        }

    /** Decodes a caller-supplied document with the same strict JSON configuration used for core scenarios. */
    fun <T> decode(
        text: String,
        deserializer: DeserializationStrategy<T>,
    ): T = json.decodeFromString(deserializer, text)

    fun decodeScenario(text: String): Scenario = decode(text, Scenario.serializer())

    fun encodeScenario(value: Scenario): String = json.encodeToString(value)

    fun decodeExperiment(text: String): ExperimentDocument {
        val document = decode(text, ExperimentDocument.serializer())
        requireSupportedSchemaVersion(document.schemaVersion)
        return document
    }

    fun encodeExperiment(value: ExperimentDocument): String {
        requireSupportedSchemaVersion(value.schemaVersion)
        return json.encodeToString(value)
    }

    fun decodeSweep(text: String): SweepDocument {
        val document = decode(text, SweepDocument.serializer())
        requireSupportedSchemaVersion(document.schemaVersion)
        return document
    }

    fun encodeSweep(value: SweepDocument): String {
        requireSupportedSchemaVersion(value.schemaVersion)
        return json.encodeToString(value)
    }

    /** Rejects schema versions other than the single version supported by this core release. */
    fun requireSupportedSchemaVersion(version: Int) {
        require(version == SUPPORTED_SCHEMA_VERSION) {
            "Unsupported schemaVersion: $version; expected $SUPPORTED_SCHEMA_VERSION"
        }
    }
}
