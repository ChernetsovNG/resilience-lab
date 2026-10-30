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

/**
 * Event-time call statistics for [startMs, startMs + durationMs), including warm-up and excluding run-out.
 * Latency includes responses observed by the caller; timeouts and late responses do not contribute samples.
 * Pool integrals cover this window; wait counts and full wait durations belong to the wait-completion window.
 * Pool fields are zero without a pool; deadline expiry is excluded from [poolAcquireTimeouts].
 */
@Serializable
data class ConnectionWindowMetrics(
    val startMs: Double,
    val durationMs: Double,
    val sentAttempts: Int = 0,
    val retries: Int = 0,
    val succeeded: Int = 0,
    val failed: Int = 0,
    val timeouts: Int = 0,
    val orphaned: Int = 0,
    val inFlightIntegralMs: Double = 0.0,
    val orphanedIntegralMs: Double = 0.0,
    val backoffIntegralMs: Double = 0.0,
    val latency: LatencyStatistics = LatencyStatistics(),
    val poolBusyTimeMs: Double = 0.0,
    val poolCapacityTimeMs: Double = 0.0,
    val poolQueueIntegralMs: Double = 0.0,
    val poolWaitCount: Int = 0,
    val poolWaitTimeMs: Double = 0.0,
    val poolAcquireTimeouts: Int = 0,
)

/** One connection in a closed window, passed directly to the artifact writer. */
data class ConnectionWindow(
    val id: String,
    val metrics: ConnectionWindowMetrics,
)

/** Windows of a connection within the containing part's half-open index range. */
@Serializable
data class ConnectionSeries(
    val id: String,
    val windows: List<ConnectionWindowMetrics>,
)

/** A group of nodes and connections on a contiguous window range; the latency profile applies to every contained sketch. */
@Serializable
data class SeriesPart(
    val schemaVersion: Int = Versions.SERIES_SCHEMA,
    val profile: String = LatencySketch.PROFILE,
    val fromWindow: Int,
    val untilWindow: Int,
    val nodes: List<NodeSeries>,
    val connections: List<ConnectionSeries> = emptyList(),
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
    val connections: List<String> = emptyList(),
)

/** Complete node and connection × window coverage of one variant × p0 × replication task. */
@Serializable
data class SeriesIndex(
    val schemaVersion: Int,
    val endMs: Double,
    val windowMs: Double,
    val parts: List<SeriesPartReference>,
)

/**
 * Buffers consecutive closed windows until the next would exceed 4 MiB, counting actual encoded bytes.
 * Nodes and connections are split only when an entire single window cannot fit. Memory holds the current window and encoded part.
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
    private var connectionIds: List<String>? = null
    private var pending: BufferedPart? = null

    init {
        require(maxPartBytes in 1..MAX_PART_BYTES) { "Part budget must be between 1 and $MAX_PART_BYTES bytes" }
    }

    fun writeWindow(
        index: Int,
        rows: List<NodeWindow>,
        connections: List<ConnectionWindow> = emptyList(),
    ) {
        uninterruptedArtifactWrite { writeClosedWindow(index, rows, connections) }
    }

    private fun writeClosedWindow(
        index: Int,
        rows: List<NodeWindow>,
        connections: List<ConnectionWindow>,
    ) {
        require(index == nextWindow) { "Expected window $nextWindow, received $index" }
        val sorted = rows.sortedBy { it.id }
        val ids = sorted.map { it.id }
        val sortedConnections = connections.sortedBy { it.id }
        val callIds = sortedConnections.map { it.id }
        require(ids.isNotEmpty() || callIds.isNotEmpty()) { "Window nodes and connections must not both be empty" }
        require(ids.distinct().size == ids.size) { "Window nodes must be distinct" }
        require(callIds.distinct().size == callIds.size) { "Window connections must be distinct" }
        require(nodeIds == null || nodeIds == ids) { "Every window must cover the same nodes" }
        require(connectionIds == null || connectionIds == callIds) { "Every window must cover the same connections" }
        nodeIds = ids
        connectionIds = callIds
        val baseBytes = prefix(index, index + 1).size + PART_SUFFIX_BYTES
        var window = BufferedPart(index, index + 1)
        var splitRows = false

        fun add(
            row: BufferedSeries,
            connection: Boolean,
        ) {
            if (baseBytes + row.singleWindowBytes > maxPartBytes) {
                flushPending()
                val kind = if (connection) "connection" else "node"
                throw ExperimentExecutionException("$kind=${row.id} window=$index: part size limit $maxPartBytes bytes")
            }
            val group = if (connection) window.connections else window.nodes
            val separator = if (group.isEmpty()) 0 else 1
            if (baseBytes + window.bodyBytes + separator + row.singleWindowBytes > maxPartBytes) {
                flushPending()
                persist(window)
                window = BufferedPart(index, index + 1)
                splitRows = true
            }
            window.add(row, connection)
        }
        sorted.forEach { row ->
            add(bufferedSeries(row.id, json.encodeToString(WindowMetrics.serializer(), row.metrics)), connection = false)
        }
        sortedConnections.forEach { row ->
            add(bufferedSeries(row.id, json.encodeToString(ConnectionWindowMetrics.serializer(), row.metrics)), connection = true)
        }
        if (splitRows) {
            persist(window)
        } else {
            val current = pending
            val added = window.nodes.sumOf { it.windows.single().size + 1 } + window.connections.sumOf { it.windows.single().size + 1 }
            if (current != null &&
                prefix(current.fromWindow, index + 1).size + current.bodyBytes + added + PART_SUFFIX_BYTES <= maxPartBytes
            ) {
                window.nodes.forEachIndexed { node, value -> current.nodes[node].windows += value.windows.single() }
                window.connections.forEachIndexed { connection, value -> current.connections[connection].windows += value.windows.single() }
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
            "{\"schemaVersion\":${Versions.SERIES_SCHEMA},\"profile\":\"${LatencySketch.PROFILE}\",\"fromWindow\":$from," +
                "\"untilWindow\":$until,\"nodes\":["
        ).toByteArray(Charsets.UTF_8)

    private fun bufferedSeries(
        id: String,
        metrics: String,
    ) = BufferedSeries(
        id,
        ("{\"id\":" + json.encodeToString(String.serializer(), id) + ",\"windows\":[").toByteArray(Charsets.UTF_8),
        mutableListOf(metrics.toByteArray(Charsets.UTF_8)),
    )

    private fun flushPending() {
        pending?.let { persist(it) }
        pending = null
    }

    private fun persist(part: BufferedPart) {
        val output = ByteArrayOutputStream()
        val header = prefix(part.fromWindow, part.untilWindow)
        output.write(header)

        fun writeRows(rows: List<BufferedSeries>) {
            rows.forEachIndexed { row, value ->
                if (row > 0) output.write(','.code)
                output.write(value.prefix)
                value.windows.forEachIndexed { window, bytes ->
                    if (window > 0) output.write(','.code)
                    output.write(bytes)
                }
                output.write(SUFFIX)
            }
        }
        writeRows(part.nodes)
        output.write(CONNECTIONS_PREFIX)
        writeRows(part.connections)
        output.write(SUFFIX)
        val bytes = output.toByteArray()
        check(bytes.size == header.size + part.bodyBytes + PART_SUFFIX_BYTES && bytes.size <= maxPartBytes) {
            "Part byte budget mismatch"
        }
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
                part.connections.map { it.id },
            )
    }

    private class BufferedSeries(
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
        val nodes = mutableListOf<BufferedSeries>()
        val connections = mutableListOf<BufferedSeries>()
        var bodyBytes = 0

        fun add(
            row: BufferedSeries,
            connection: Boolean,
        ) {
            val group = if (connection) connections else nodes
            bodyBytes += row.singleWindowBytes + if (group.isEmpty()) 0 else 1
            group += row
        }
    }

    /** Writes the index only after every window has been persisted. */
    fun finish(): SeriesIndex =
        uninterruptedArtifactWrite {
            require(nextWindow == expectedWindows) { "Incomplete series: $nextWindow windows" }
            flushPending()
            val index = SeriesIndex(schemaVersion = Versions.SERIES_SCHEMA, endMs = endMs, windowMs = windowMs, parts = parts.toList())
            workspace.create("$directory/index.json", DocumentCodec.encode(SeriesIndex.serializer(), index))
            index
        }

    companion object {
        const val MAX_PART_BYTES = 4 * 1024 * 1024
        private val SUFFIX = "]}".toByteArray(Charsets.UTF_8)
        private val CONNECTIONS_PREFIX = "],\"connections\":[".toByteArray(Charsets.UTF_8)
        private val PART_SUFFIX_BYTES = CONNECTIONS_PREFIX.size + SUFFIX.size
    }
}
