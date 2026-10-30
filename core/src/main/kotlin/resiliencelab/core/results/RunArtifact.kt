package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.GridAxis
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
    const val ARTIFACT_SCHEMA = 8
    const val SERIES_SCHEMA = 3
    const val REPLICATION_SCHEMA = 2
}

/** Stored results are versioned independently of input documents; old formats require a fresh run. */
class UnsupportedArtifactVersionException(
    val kind: String,
    val actual: Int?,
) : IllegalArgumentException("Unsupported $kind schemaVersion ${actual ?: "missing"}; expected ${Versions.ARTIFACT_SCHEMA}; run again")

/**
 * Reproducibility record of a run (ADR 0008): versions, stream assignment, versions of the documents read,
 * seed, SHA-256 of every part file and completeness. Contains no timestamps, so equal inputs give byte-identical
 * manifests. [grid] preserves document axis and value order independently of coordinate-map key order.
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
    val grid: List<GridAxis>,
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
    val points: List<GridPoint>,
)

/** Stable grid identity and coordinates, in document units; no grid means `p0` with empty coordinates. */
@Serializable
data class GridPoint(
    val id: String,
    val coordinates: Map<String, JsonElement>,
)

/** Cohort sufficient statistics of one task. Arrival timestamps are deliberately absent from persisted results. */
@Serializable
data class ReplicationArtifact(
    val schemaVersion: Int,
    val profile: String,
    val unit: String,
    val result: ReplicationResult,
)

/** Metrics of one variant, separated by grid point. */
@Serializable
data class VariantSummary(
    val id: String,
    val label: String,
    val replications: Int,
    val points: List<PointSummary>,
)

/** Aggregated metrics and saturation insight of one point, computed from persisted task files only. */
@Serializable
data class PointSummary(
    val id: String,
    val coordinates: Map<String, JsonElement>,
    val aggregate: AggregateMetrics,
    val saturation: SaturationSummary,
)

/** Summary of a run, loaded first by the UI; [grid] retains document axis and value order for Map. */
@Serializable
data class RunSummary(
    val schemaVersion: Int,
    val experiment: String,
    val variants: List<VariantSummary>,
    val grid: List<GridAxis>,
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
            val artifact = ReplicationArtifact(Versions.REPLICATION_SCHEMA, LatencySketch.PROFILE, "ms", result)
            workspace.create("$taskDirectory/replication.json", DocumentCodec.encode(ReplicationArtifact.serializer(), artifact))
        }
    }

    /** Rebuilds metrics and insights from persisted totals and series in variant/point/replication order. */
    fun summarize(
        runDirectory: String,
        experiment: String,
        variants: List<Pair<String, String>>,
        replications: Int,
        points: List<GridPoint>,
        grid: List<GridAxis>,
        callChain: List<String>,
    ): RunSummary {
        val json = Json { explicitNulls = false }
        val saturationReader = SaturationArtifactReader(workspace)
        return RunSummary(
            Versions.ARTIFACT_SCHEMA,
            experiment,
            variants.map { (id, label) ->
                val summaries =
                    points.map { point ->
                        val stored =
                            (0 until replications).map { replication ->
                                val directory = "$runDirectory/series/$id/${point.id}/rep-$replication"
                                val path = "$directory/replication.json"
                                val artifact = json.decodeFromString(ReplicationArtifact.serializer(), workspace.read(path).text)
                                require(
                                    artifact.schemaVersion == Versions.REPLICATION_SCHEMA &&
                                        artifact.profile == LatencySketch.PROFILE &&
                                        artifact.unit == "ms",
                                ) {
                                    "Unsupported replication format in '$path'"
                                }
                                artifact.result to saturationReader.read(directory, replication, callChain)
                            }
                        PointSummary(
                            point.id,
                            point.coordinates,
                            MetricsAggregator.aggregate(stored.map { it.first }),
                            SaturationAnalyzer.aggregate(stored.map { it.second }),
                        )
                    }
                VariantSummary(id, label, replications, summaries)
            },
            grid,
        )
    }

    /** Writes [summary], then [manifest] with the checksums of the written parts, and returns that manifest. */
    fun write(
        runDirectory: String,
        manifest: RunManifest,
        summary: RunSummary?,
    ): RunManifest = write(runDirectory, manifest, summary, replaceExisting = false)

    /** Replaces an incomplete artifact's summary and manifest after its invalid tasks have been recomputed. */
    fun rewrite(
        runDirectory: String,
        manifest: RunManifest,
        summary: RunSummary?,
    ): RunManifest = write(runDirectory, manifest, summary, replaceExisting = true)

    private fun write(
        runDirectory: String,
        manifest: RunManifest,
        summary: RunSummary?,
        replaceExisting: Boolean,
    ): RunManifest =
        uninterruptedArtifactWrite {
            val summaryPath = "$runDirectory/summary.json"
            val manifestPath = "$runDirectory/manifest.json"
            if (!replaceExisting && workspace.exists(manifestPath)) throw DocumentExistsException(manifestPath)
            if (!replaceExisting && summary != null && workspace.exists(summaryPath)) throw DocumentExistsException(summaryPath)

            if (replaceExisting && summary == null) workspace.delete(summaryPath)
            if (summary != null) {
                val encoded = DocumentCodec.encode(RunSummary.serializer(), summary)
                if (replaceExisting && workspace.exists(summaryPath)) {
                    workspace.write(summaryPath, encoded)
                } else {
                    workspace.create(summaryPath, encoded)
                }
            }
            val parts =
                workspace
                    .listFiles(runDirectory)
                    .filter { it != manifestPath }
                    .associate { path ->
                        path.removePrefix("$runDirectory/") to DocumentVersion.of(workspace.readBytes(path))
                    }.toSortedMap()
            val written = manifest.copy(parts = parts, complete = summary != null && manifest.complete)
            val encoded = DocumentCodec.encode(RunManifest.serializer(), written)
            if (replaceExisting && workspace.exists(manifestPath)) {
                workspace.write(manifestPath, encoded)
            } else {
                workspace.create(manifestPath, encoded)
            }
            written
        }
}
