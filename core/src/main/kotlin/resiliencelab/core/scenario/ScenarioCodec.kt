package resiliencelab.core.scenario

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

    fun decodeScenario(text: String): Scenario = json.decodeFromString(text)

    fun encodeScenario(value: Scenario): String = json.encodeToString(value)

    fun decodeExperiment(text: String): ExperimentDocument {
        val document = json.decodeFromString<ExperimentDocument>(text)
        requireSupportedSchemaVersion(document.schemaVersion)
        return document
    }

    fun encodeExperiment(value: ExperimentDocument): String {
        requireSupportedSchemaVersion(value.schemaVersion)
        return json.encodeToString(value)
    }

    fun decodeSweep(text: String): SweepDocument {
        val document = json.decodeFromString<SweepDocument>(text)
        requireSupportedSchemaVersion(document.schemaVersion)
        return document
    }

    fun encodeSweep(value: SweepDocument): String {
        requireSupportedSchemaVersion(value.schemaVersion)
        return json.encodeToString(value)
    }

    private fun requireSupportedSchemaVersion(version: Int) {
        require(version == SUPPORTED_SCHEMA_VERSION) {
            "Unsupported schemaVersion: $version; expected $SUPPORTED_SCHEMA_VERSION"
        }
    }
}
