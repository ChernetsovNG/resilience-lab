package resiliencelab.core.results

import kotlinx.serialization.Serializable
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.Workspace

/** Versions recorded in every manifest (ADR 0008; D6). */
object Versions {
    const val APPLICATION = "0.1.0"
    const val KSL = "R1.8.1"
}

/**
 * Reproducibility record of a run (ADR 0008): versions, stream assignment, versions of the documents read,
 * seed, SHA-256 of every part file and completeness. Contains no timestamps, so equal inputs give byte-identical
 * manifests.
 */
@Serializable
data class RunManifest(
    val schemaVersion: Int,
    val applicationVersion: String,
    val kslVersion: String,
    val streamAssignment: String,
    val experiment: String,
    val documents: Map<String, String>,
    val seed: Long,
    val replications: Int,
    val variants: List<String>,
    val parts: Map<String, String>,
    val complete: Boolean,
)

/** Aggregated metrics of one variant. */
@Serializable
data class VariantSummary(
    val id: String,
    val label: String,
    val replications: Int,
    val aggregate: AggregateMetrics,
)

/** Summary of a run, loaded first by the UI. */
@Serializable
data class RunSummary(
    val schemaVersion: Int,
    val experiment: String,
    val variants: List<VariantSummary>,
)

/** Workspace locations of run artifacts (ADR 0008, item 1). */
object ResultsLayout {
    private val segment = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")

    /**
     * `.results/<experiment name without .experiment.json>/<runId>`. Both parts must be single plain path segments, so
     * an artifact can never be written outside `.results/`.
     */
    fun runDirectory(
        experimentPath: String,
        runId: String,
    ): String {
        val name = experimentPath.substringAfterLast('/').removeSuffix(".experiment.json")
        require(segment.matches(name)) { "Experiment name '$name' cannot name a results directory" }
        require(segment.matches(runId)) { "Run id '$runId' must match ${segment.pattern}" }
        return ".results/$name/$runId"
    }
}

/** Writes the artifact; the manifest goes last so that its presence marks a finished run. */
class ArtifactWriter(
    private val workspace: Workspace,
) {
    /** Writes [summary], then [manifest] with the checksums of the written parts, and returns that manifest. */
    fun write(
        runDirectory: String,
        manifest: RunManifest,
        summary: RunSummary,
    ): RunManifest {
        val summaryPath = "$runDirectory/summary.json"
        val manifestPath = "$runDirectory/manifest.json"
        if (workspace.exists(summaryPath)) throw DocumentExistsException(summaryPath)
        if (workspace.exists(manifestPath)) throw DocumentExistsException(manifestPath)

        val summaryVersion = workspace.create(summaryPath, DocumentCodec.encode(RunSummary.serializer(), summary))
        val written = manifest.copy(parts = mapOf("summary.json" to summaryVersion))
        workspace.create(manifestPath, DocumentCodec.encode(RunManifest.serializer(), written))
        return written
    }
}
