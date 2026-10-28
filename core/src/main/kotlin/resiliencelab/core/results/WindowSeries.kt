package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
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
 * Queue rejections contribute only to their counter, never to the service residence sketch.
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
 * Buffers consecutive closed windows until the next would exceed 4 MiB, counting actual encoded bytes.
 * Nodes are split only when an entire single window cannot fit. Memory holds the current window and encoded part.
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
    private var pending: BufferedPart? = null

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
        val baseBytes = prefix(index, index + 1).size + SUFFIX.size
        var window = BufferedPart(index, index + 1)
        var splitNodes = false
        sorted.forEach { row ->
            val node =
                BufferedNode(
                    row.id,
                    ("{\"id\":" + json.encodeToString(String.serializer(), row.id) + ",\"windows\":[").toByteArray(Charsets.UTF_8),
                    mutableListOf(json.encodeToString(WindowMetrics.serializer(), row.metrics).toByteArray(Charsets.UTF_8)),
                )
            if (baseBytes + node.singleWindowBytes > maxPartBytes) {
                flushPending()
                throw ExperimentExecutionException("node=${row.id} window=$index: part size limit $maxPartBytes bytes")
            }
            val separator = if (window.nodes.isEmpty()) 0 else 1
            if (baseBytes + window.bodyBytes + separator + node.singleWindowBytes > maxPartBytes) {
                flushPending()
                persist(window)
                window = BufferedPart(index, index + 1)
                splitNodes = true
            }
            window.add(node)
        }
        if (splitNodes) {
            persist(window)
        } else {
            val current = pending
            val added = window.nodes.sumOf { it.windows.single().size + 1 }
            if (current != null && prefix(current.fromWindow, index + 1).size + current.bodyBytes + added + SUFFIX.size <= maxPartBytes) {
                window.nodes.forEachIndexed { node, value -> current.nodes[node].windows += value.windows.single() }
                current.bodyBytes += added
                current.untilWindow = index + 1
            } else {
                flushPending()
                pending = window
            }
        }
        nextWindow++
    }

    private fun prefix(
        from: Int,
        until: Int,
    ): ByteArray =
        (
            "{\"schemaVersion\":1,\"profile\":\"${LatencySketch.PROFILE}\",\"fromWindow\":$from," +
                "\"untilWindow\":$until,\"nodes\":["
        ).toByteArray(Charsets.UTF_8)

    private fun flushPending() {
        pending?.let { persist(it) }
        pending = null
    }

    private fun persist(part: BufferedPart) {
        val output = ByteArrayOutputStream()
        val header = prefix(part.fromWindow, part.untilWindow)
        output.write(header)
        part.nodes.forEachIndexed { node, value ->
            if (node > 0) output.write(','.code)
            output.write(value.prefix)
            value.windows.forEachIndexed { window, bytes ->
                if (window > 0) output.write(','.code)
                output.write(bytes)
            }
            output.write(SUFFIX)
        }
        output.write(SUFFIX)
        val bytes = output.toByteArray()
        check(bytes.size == header.size + part.bodyBytes + SUFFIX.size && bytes.size <= maxPartBytes) { "Part byte budget mismatch" }
        val compressed = ByteArrayOutputStream().also { buffer -> GZIPOutputStream(buffer).use { it.write(bytes) } }.toByteArray()
        val file = "part-${parts.size}.json.gz"
        val checksum = workspace.createBytes("$directory/$file", compressed)
        parts +=
            SeriesPartReference(
                file,
                part.nodes.map { it.id },
                part.fromWindow,
                part.untilWindow,
                bytes.size,
                checksum,
            )
    }

    private class BufferedNode(
        val id: String,
        val prefix: ByteArray,
        val windows: MutableList<ByteArray>,
    ) {
        val singleWindowBytes: Int get() = prefix.size + windows.single().size + SUFFIX.size
    }

    private class BufferedPart(
        val fromWindow: Int,
        var untilWindow: Int,
    ) {
        val nodes = mutableListOf<BufferedNode>()
        var bodyBytes = 0

        fun add(node: BufferedNode) {
            bodyBytes += node.singleWindowBytes + if (nodes.isEmpty()) 0 else 1
            nodes += node
        }
    }

    /** Writes the index only after every window has been persisted. */
    fun finish(): SeriesIndex =
        uninterruptedArtifactWrite {
            require(nextWindow == expectedWindows) { "Incomplete series: $nextWindow windows" }
            flushPending()
            val index = SeriesIndex(schemaVersion = 1, endMs = endMs, windowMs = windowMs, parts = parts.toList())
            workspace.create("$directory/index.json", DocumentCodec.encode(SeriesIndex.serializer(), index))
            index
        }

    companion object {
        const val MAX_PART_BYTES = 4 * 1024 * 1024
        private val SUFFIX = "]}".toByteArray(Charsets.UTF_8)
    }
}
