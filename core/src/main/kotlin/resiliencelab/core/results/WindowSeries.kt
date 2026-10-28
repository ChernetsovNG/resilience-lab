package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.engine.ksl.ExperimentExecutionException
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.LatencyStatistics
import resiliencelab.core.ir.windowCount
import resiliencelab.core.workspace.Workspace
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream

/**
 * Event-time sufficient statistics for [startMs, startMs + durationMs). Includes warm-up, excludes run-out.
 * Client latencies belong to the completion window; service latencies cover queueing plus handler holding.
 * These populations differ from the measured-arrival cohort in replication.json, whose outcomes include run-out.
 */
@Serializable
data class WindowMetrics(
    val startMs: Double,
    val durationMs: Double,
    val originalArrivals: Int = 0,
    val offeredAttempts: Int = 0,
    val admittedAttempts: Int = 0,
    val queueRejections: Int = 0,
    val successes: Int = 0,
    val failures: Int = 0,
    val timeouts: Int = 0,
    val retries: Int = 0,
    val busyHandlerTimeMs: Double = 0.0,
    val handlers: Int = 0,
    val queueLengthIntegralMs: Double = 0.0,
    val latency: LatencyStatistics = LatencyStatistics(),
)

/** One node in a closed window, passed directly to the artifact writer. */
data class NodeWindow(
    val id: String,
    val metrics: WindowMetrics,
)

/** Windows of a node within the containing part's half-open index range. */
@Serializable
data class NodeSeries(
    val id: String,
    val windows: List<WindowMetrics>,
)

/** A group of nodes on a contiguous window range; the latency profile applies to every contained sketch. */
@Serializable
data class SeriesPart(
    val schemaVersion: Int = 1,
    val profile: String = LatencySketch.PROFILE,
    val fromWindow: Int,
    val untilWindow: Int,
    val nodes: List<NodeSeries>,
)

/** SHA-256 covers the stored gzip bytes; [uncompressedBytes] is the actual UTF-8 JSON size before compression. */
@Serializable
data class SeriesPartReference(
    val file: String,
    val nodes: List<String>,
    val fromWindow: Int,
    val untilWindow: Int,
    val uncompressedBytes: Int,
    val sha256: String,
)

/** Complete node × window coverage of one variant × p0 × replication task. */
@Serializable
data class SeriesIndex(
    val schemaVersion: Int,
    val endMs: Double,
    val windowMs: Double,
    val parts: List<SeriesPartReference>,
)

/**
 * Writes each closed window immediately, splitting its sorted nodes by actual encoded size. A one-window range
 * is deliberately used for every part: memory is bounded by the current window and a part of at most 4 MiB.
 * Part boundaries depend only on the data. Java gzip headers contain no wall-clock timestamp.
 */
class SeriesWriter(
    private val workspace: Workspace,
    private val directory: String,
    private val endMs: Double,
    private val windowMs: Double,
    private val maxPartBytes: Int = MAX_PART_BYTES,
) {
    private val expectedWindows = windowCount(endMs, windowMs)
    private val json = Json { encodeDefaults = true }
    private val parts = mutableListOf<SeriesPartReference>()
    private var nextWindow = 0
    private var nodeIds: List<String>? = null

    init {
        require(maxPartBytes in 1..MAX_PART_BYTES) { "Part budget must be between 1 and $MAX_PART_BYTES bytes" }
    }

    fun writeWindow(
        index: Int,
        rows: List<NodeWindow>,
    ) {
        uninterruptedArtifactWrite { writeClosedWindow(index, rows) }
    }

    private fun writeClosedWindow(
        index: Int,
        rows: List<NodeWindow>,
    ) {
        require(index == nextWindow) { "Expected window $nextWindow, received $index" }
        val sorted = rows.sortedBy { it.id }
        val ids = sorted.map { it.id }
        require(ids.isNotEmpty() && ids.distinct().size == ids.size) { "Window nodes must be distinct and nonempty" }
        require(nodeIds == null || nodeIds == ids) { "Every window must cover the same nodes" }
        nodeIds = ids
        val prefix =
            "{\"schemaVersion\":1,\"profile\":\"${LatencySketch.PROFILE}\",\"fromWindow\":$index," +
                "\"untilWindow\":${index + 1},\"nodes\":["
        val suffix = "]}".toByteArray()
        var output = ByteArrayOutputStream().apply { write(prefix.toByteArray()) }
        var currentNodes = mutableListOf<String>()

        fun flush() {
            output.write(suffix)
            val bytes = output.toByteArray()
            val compressed = ByteArrayOutputStream().also { buffer -> GZIPOutputStream(buffer).use { it.write(bytes) } }.toByteArray()
            val file = "part-${parts.size}.json.gz"
            val checksum = workspace.createBytes("$directory/$file", compressed)
            parts += SeriesPartReference(file, currentNodes.toList(), index, index + 1, bytes.size, checksum)
            output = ByteArrayOutputStream().apply { write(prefix.toByteArray()) }
            currentNodes = mutableListOf()
        }
        sorted.forEach { row ->
            val bytes = json.encodeToString(NodeSeries.serializer(), NodeSeries(row.id, listOf(row.metrics))).toByteArray()
            if (prefix.toByteArray().size + bytes.size + suffix.size > maxPartBytes) {
                throw ExperimentExecutionException("node=${row.id} window=$index: part size limit $maxPartBytes bytes")
            }
            val separator = if (currentNodes.isEmpty()) 0 else 1
            if (output.size() + separator + bytes.size + suffix.size > maxPartBytes) flush()
            if (currentNodes.isNotEmpty()) output.write(','.code)
            output.write(bytes)
            currentNodes += row.id
        }
        if (currentNodes.isNotEmpty()) flush()
        nextWindow++
    }

    /** Writes the index only after every window has been persisted. */
    fun finish(): SeriesIndex =
        uninterruptedArtifactWrite {
            require(nextWindow == expectedWindows) { "Incomplete series: $nextWindow windows" }
            val index = SeriesIndex(schemaVersion = 1, endMs = endMs, windowMs = windowMs, parts = parts.toList())
            workspace.create("$directory/index.json", DocumentCodec.encode(SeriesIndex.serializer(), index))
            index
        }

    companion object {
        const val MAX_PART_BYTES = 4 * 1024 * 1024
    }
}
