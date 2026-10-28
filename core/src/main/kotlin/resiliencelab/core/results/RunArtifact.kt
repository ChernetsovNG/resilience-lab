package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.MetricsAggregator
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.Workspace
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask

/**
 * Lets an in-flight artifact operation finish despite cancellation of its caller. FileChannel.lock is interruptible,
 * so merely clearing a worker's flag before I/O is insufficient: another interrupt can arrive during the lock.
 * The dedicated virtual thread is never interrupted; all caller interruptions are restored after it finishes.
 */
internal fun <T> uninterruptedArtifactWrite(action: () -> T): T {
    val write = FutureTask(action)
    Thread.ofVirtual().name("artifact-write").start(write)
    var interrupted = false
    try {
        while (true) {
            try {
                return write.get()
            } catch (_: InterruptedException) {
                interrupted = true
            } catch (failure: ExecutionException) {
                throw failure.cause ?: failure
            }
        }
    } finally {
        if (interrupted) Thread.currentThread().interrupt()
    }
}

/** Versions recorded in every manifest (ADR 0008; D6). */
object Versions {
    const val APPLICATION = "0.1.0"
    const val KSL = "R1.8.1"
    const val ARTIFACT_SCHEMA = 2
}

/** Stored results are versioned independently of input documents; old formats require a fresh run. */
class UnsupportedArtifactVersionException(
    kind: String,
    actual: Int?,
) : IllegalArgumentException("Unsupported $kind schemaVersion ${actual ?: "missing"}; expected ${Versions.ARTIFACT_SCHEMA}; run again")

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
    val series: SeriesMetadata? = null,
)

/** Time grid, sketch version and population semantics shared by all series tasks. All durations are in ms. */
@Serializable
data class SeriesMetadata(
    val warmupMs: Double,
    val measurementMs: Double,
    val windowMs: Double,
    val sketchProfile: String,
    val sketchLibraryVersion: String,
    val timeUnit: String,
    val timeBasis: String,
    val replicationBasis: String,
    val points: List<String>,
)

/** Cohort sufficient statistics of one task. Arrival timestamps are deliberately absent from persisted results. */
@Serializable
data class ReplicationArtifact(
    val schemaVersion: Int,
    val profile: String,
    val unit: String,
    val result: ReplicationResult,
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
    /** Publishes a task's fully drained cohort totals immediately, before reporting its completion. */
    fun writeReplication(
        taskDirectory: String,
        result: ReplicationResult,
    ) {
        uninterruptedArtifactWrite {
            val artifact = ReplicationArtifact(1, LatencySketch.PROFILE, "ms", result)
            workspace.create("$taskDirectory/replication.json", DocumentCodec.encode(ReplicationArtifact.serializer(), artifact))
        }
    }

    /** Rebuilds the summary using only persisted totals, reducing them in variant/point/replication order. */
    fun summarize(
        runDirectory: String,
        experiment: String,
        variants: List<Pair<String, String>>,
        replications: Int,
    ): RunSummary {
        val json = Json { explicitNulls = false }
        return RunSummary(
            Versions.ARTIFACT_SCHEMA,
            experiment,
            variants.map { (id, label) ->
                val totals =
                    (0 until replications).map { replication ->
                        val path = "$runDirectory/series/$id/p0/rep-$replication/replication.json"
                        val artifact = json.decodeFromString(ReplicationArtifact.serializer(), workspace.read(path).text)
                        require(artifact.schemaVersion == 1 && artifact.profile == LatencySketch.PROFILE && artifact.unit == "ms") {
                            "Unsupported replication format in '$path'"
                        }
                        artifact.result
                    }
                VariantSummary(id, label, replications, MetricsAggregator.aggregate(totals))
            },
        )
    }

    /** Writes [summary], then [manifest] with the checksums of the written parts, and returns that manifest. */
    fun write(
        runDirectory: String,
        manifest: RunManifest,
        summary: RunSummary?,
    ): RunManifest =
        uninterruptedArtifactWrite {
            val summaryPath = "$runDirectory/summary.json"
            val manifestPath = "$runDirectory/manifest.json"
            if (workspace.exists(manifestPath)) throw DocumentExistsException(manifestPath)
            if (summary != null && workspace.exists(summaryPath)) throw DocumentExistsException(summaryPath)

            if (summary != null) workspace.create(summaryPath, DocumentCodec.encode(RunSummary.serializer(), summary))
            val parts =
                workspace
                    .listFiles(runDirectory)
                    .associate { path ->
                        path.removePrefix("$runDirectory/") to DocumentVersion.of(workspace.readBytes(path))
                    }.toSortedMap()
            val written = manifest.copy(parts = parts, complete = summary != null && manifest.complete)
            workspace.create(manifestPath, DocumentCodec.encode(RunManifest.serializer(), written))
            written
        }
}
