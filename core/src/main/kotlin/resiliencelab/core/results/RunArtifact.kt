package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.Severity
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.GridAxis
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.MetricsAggregator
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.Workspace
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

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
    const val ARTIFACT_SCHEMA = 17
    const val SERIES_SCHEMA = 7
    const val REPLICATION_SCHEMA = 6
}

/** Stored results are versioned independently of input documents; old formats require a fresh run. */
class UnsupportedArtifactVersionException(
    val kind: String,
    val actual: Int?,
    val expected: Int = Versions.ARTIFACT_SCHEMA,
) : IllegalArgumentException("Unsupported $kind schemaVersion ${actual ?: "missing"}; expected $expected; run again")

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
    /** Canonical JSON of the computation inputs, keyed like [documents] and covered by those hashes. */
    val snapshots: Map<String, String> = emptyMap(),
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
    val headroom: CapacityHeadroom = CapacityHeadroom(),
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

    /** Run group for a canonical workspace-relative experiment; inspecting it never visits another experiment. */
    fun experimentDirectory(experimentPath: String): String = ".results/${DocumentVersion.of(experimentPath)}"

    /** Completion metadata alongside run directories, outside the reproducible artifact and its checksums. */
    fun completionMarker(runDirectory: String): String =
        "${runDirectory.substringBeforeLast('/')}/.completed-${runDirectory.substringAfterLast('/')}"

    /**
     * `.results/<SHA-256 of the canonical workspace-relative experiment path>/<runId>`.
     * Document names are unrestricted by the results layout; the hash and validated run ID are plain path segments.
     * Callers resolve path aliases through [Workspace.canonicalPath] before deriving the directory.
     */
    fun runDirectory(
        experimentPath: String,
        runId: String,
    ): String {
        if (!segment.matches(runId)) {
            throw InvalidExperimentException(
                listOf(
                    Diagnostic(
                        CoreMessage.RUN_ID,
                        Severity.ERROR,
                        "Run id '$runId' must match ${segment.pattern}",
                        experimentPath,
                        args = mapOf("id" to JsonPrimitive(runId), "pattern" to JsonPrimitive(segment.pattern)),
                    ),
                ),
            )
        }
        return "${experimentDirectory(experimentPath)}/$runId"
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
            val bytes = DocumentCodec.encode(ReplicationArtifact.serializer(), artifact).toByteArray(Charsets.UTF_8)
            val compressed = ByteArrayOutputStream().also { buffer -> GZIPOutputStream(buffer).use { it.write(bytes) } }.toByteArray()
            workspace.createBytes("$taskDirectory/replication.json.gz", compressed)
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
        graphs: Map<String, Map<String, GraphIr>> = emptyMap(),
    ): RunSummary {
        val json = Json { explicitNulls = false }
        val saturationReader = SaturationArtifactReader(workspace)
        return RunSummary(
            Versions.ARTIFACT_SCHEMA,
            experiment,
            variants.map { (id, label) ->
                val summaries =
                    points.map { point ->
                        val graph = graphs[id]?.get(point.id)
                        val labels = graph?.let(SlotPoolLabels::from).orEmpty()
                        val positions = graph?.let(SlotPoolLabels::positions) ?: callChain.withIndex().associate { it.value to it.index }
                        val stored =
                            (0 until replications).map { replication ->
                                val directory = "$runDirectory/series/$id/${point.id}/rep-$replication"
                                val path = "$directory/replication.json.gz"
                                val text =
                                    GZIPInputStream(workspace.readBytes(path).inputStream())
                                        .bufferedReader(Charsets.UTF_8)
                                        .use { it.readText() }
                                val version =
                                    json
                                        .parseToJsonElement(text)
                                        .jsonObject["schemaVersion"]
                                        ?.jsonPrimitive
                                        ?.intOrNull
                                if (version != Versions.REPLICATION_SCHEMA) {
                                    throw UnsupportedArtifactVersionException("replication", version, Versions.REPLICATION_SCHEMA)
                                }
                                val artifact = json.decodeFromString(ReplicationArtifact.serializer(), text)
                                require(
                                    artifact.schemaVersion == Versions.REPLICATION_SCHEMA &&
                                        artifact.profile == LatencySketch.PROFILE &&
                                        artifact.unit == "ms",
                                ) {
                                    "Unsupported replication format in '$path'"
                                }
                                artifact.result to saturationReader.read(directory, replication, callChain, labels, positions)
                            }
                        val aggregate = MetricsAggregator.aggregate(stored.map { it.first })
                        PointSummary(
                            point.id,
                            point.coordinates,
                            aggregate,
                            SaturationAnalyzer.aggregate(stored.map { it.second }),
                            CapacityHeadroomAnalyzer.analyze(aggregate, labels),
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
            // A lost summary must not turn a completed run into an unfinished one. This cache is optional:
            // failure to update it must not discard an already published artifact; summary presence is the fallback.
            runCatching {
                val marker = ResultsLayout.completionMarker(runDirectory)
                if (written.complete) workspace.write(marker, "") else workspace.delete(marker)
            }
            written
        }
}
