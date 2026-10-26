package resiliencelab.server.api

import resiliencelab.core.scenario.ScenarioCodec

/** Decodes submissions using core JSON settings and enforces document cardinality and schema versions. */
object ExperimentSubmissionCodec {
    /** Decodes one submission without performing scenario validation or sweep expansion. */
    fun decode(body: String): ExperimentSubmission {
        val submission = ScenarioCodec.decode(body, ExperimentSubmission.serializer())
        require((submission.experiment == null) xor (submission.sweep == null)) {
            "Exactly one of experiment or sweep must be provided"
        }
        submission.experiment?.let { ScenarioCodec.requireSupportedSchemaVersion(it.schemaVersion) }
        submission.sweep?.let { ScenarioCodec.requireSupportedSchemaVersion(it.schemaVersion) }
        return submission
    }
}
