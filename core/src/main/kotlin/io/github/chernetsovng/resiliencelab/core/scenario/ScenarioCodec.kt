package io.github.chernetsovng.resiliencelab.core.scenario

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

object ScenarioCodec {
    private const val SUPPORTED_SCHEMA_VERSION = 1

    private val json = Json {
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

    private fun requireSupportedSchemaVersion(version: Int) {
        require(version == SUPPORTED_SCHEMA_VERSION) {
            "Unsupported schemaVersion: $version; expected $SUPPORTED_SCHEMA_VERSION"
        }
    }
}
