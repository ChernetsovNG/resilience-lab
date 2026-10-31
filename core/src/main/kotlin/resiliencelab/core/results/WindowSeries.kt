package resiliencelab.core.results

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.engine.ksl.ExperimentExecutionException
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.LatencyStatistics
import resiliencelab.core.experiment.ReplicaGroup
import resiliencelab.core.experiment.ReplicaGroupKind
import resiliencelab.core.experiment.SlotPoolMetrics
import resiliencelab.core.ir.windowCount
import resiliencelab.core.workspace.Workspace
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream

/**
 * Event-time sufficient statistics for [startMs, startMs + durationMs). Includes warm-up, excludes run-out.
 * Client latencies belong to the completion window; service latencies cover queueing plus handler holding.
 * Queue rejections contribute only to their counter, never to the service residence sketch.
 * These populations differ from the measured-arrival cohort in replication.json.gz, whose outcomes include run-out.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class WindowMetrics(
    val startMs: Double,
    val durationMs: Double,
    val originalArrivals: Int = 0,
    val offeredAttempts: Int = 0,
    val admittedAttempts: Int = 0,
    val successes: Int = 0,
    val failures: Int = 0,
    val timeouts: Int = 0,
    val retries: Int = 0,
    val latency: LatencyStatistics = LatencyStatistics(),
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
    /** All clients' original requests in this window, available on every independently loaded row; never a summed group counter. */
    @EncodeDefault val clientOriginalArrivals: Int = 0,
    @EncodeDefault val failuresByReason: Map<String, Int> = emptyMap(),
    @EncodeDefault val degraded: Int = 0,
    @EncodeDefault val rateLimited: Int = 0,
    @EncodeDefault val probes: Int = 0,
    @EncodeDefault val probeFailures: Int = 0,
    @EncodeDefault val notReadyMs: Double = 0.0,
    @EncodeDefault val ejections: Int = 0,
    @EncodeDefault val ejectedMs: Double = 0.0,
)

/** One node in a closed window, passed directly to the artifact writer. */
data class NodeWindow(
    val id: String,
    val metrics: WindowMetrics,
    val isClass: Boolean = false,
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
 * Missing pools are omitted; deadline expiry is excluded from pool wait-limit rejections.
 */
@OptIn(ExperimentalSerializationApi::class)
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
    @EncodeDefault val slotPools: Map<String, SlotPoolMetrics> = emptyMap(),
    @EncodeDefault val failuresByReason: Map<String, Int> = emptyMap(),
    @EncodeDefault val circuitOpenMs: Double = 0.0,
    @EncodeDefault val circuitRejections: Int = 0,
    @EncodeDefault val retriesDenied: Int = 0,
    @EncodeDefault val fallbacks: Int = 0,
    /** All clients' original requests in this window; copied-call groups retain the same denominator. */
    @EncodeDefault val clientOriginalArrivals: Int = 0,
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

/** Row population stored independently so group loading does not require instance parts. */
@Serializable
enum class SeriesPartKind { INSTANCE, GROUP }

/** A group of nodes and connections on a contiguous window range; the latency profile applies to every contained sketch. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SeriesPart(
    val schemaVersion: Int = Versions.SERIES_SCHEMA,
    @EncodeDefault val kind: SeriesPartKind = SeriesPartKind.INSTANCE,
    val profile: String = LatencySketch.PROFILE,
    val fromWindow: Int,
    val untilWindow: Int,
    val nodes: List<NodeSeries>,
    val connections: List<ConnectionSeries> = emptyList(),
    @EncodeDefault val classes: List<NodeSeries> = emptyList(),
)

/** SHA-256 covers the stored gzip bytes; [uncompressedBytes] is the actual UTF-8 JSON size before compression. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SeriesPartReference(
    val file: String,
    val nodes: List<String>,
    val fromWindow: Int,
    val untilWindow: Int,
    val uncompressedBytes: Int,
    val sha256: String,
    val connections: List<String> = emptyList(),
    @EncodeDefault val kind: SeriesPartKind = SeriesPartKind.INSTANCE,
    @EncodeDefault val classes: List<String> = emptyList(),
)

/** Complete node and connection × window coverage of one variant × p0 × replication task. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SeriesIndex(
    val schemaVersion: Int,
    val endMs: Double,
    val windowMs: Double,
    val parts: List<SeriesPartReference>,
    @EncodeDefault val groups: List<ReplicaGroup> = emptyList(),
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
    private val groups: List<ReplicaGroup> = emptyList(),
) {
    private val expectedWindows = windowCount(endMs, windowMs)

    @OptIn(ExperimentalSerializationApi::class)
    private val json =
        Json {
            encodeDefaults = true
            explicitNulls = false
        }
    private val parts = mutableListOf<SeriesPartReference>()
    private var nextWindow = 0
    private var nodeIds: List<String>? = null
    private var connectionIds: List<String>? = null
    private var classIds: List<String>? = null
    private val pending = mutableMapOf<SeriesPartKind, BufferedPart>()
    private val groupNodeIds = groups.filter { it.kind == ReplicaGroupKind.NODE }.map { it.id }.toSet()
    private val groupCallIds = groups.filter { it.kind == ReplicaGroupKind.CONNECTION }.map { it.id }.toSet()

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
        val sorted = rows.filterNot { it.isClass }.sortedBy { it.id }
        val sortedClasses = rows.filter { it.isClass }.sortedBy { it.id }
        val idsOfClasses = sortedClasses.map { it.id }
        val ids = sorted.map { it.id }
        val sortedConnections = connections.sortedBy { it.id }
        val callIds = sortedConnections.map { it.id }
        require(
            ids.isNotEmpty() || callIds.isNotEmpty() || idsOfClasses.isNotEmpty(),
        ) { "Window nodes and connections must not both be empty" }
        require(ids.distinct().size == ids.size) { "Window nodes must be distinct" }
        require(callIds.distinct().size == callIds.size) { "Window connections must be distinct" }
        require(nodeIds == null || nodeIds == ids) { "Every window must cover the same nodes" }
        require(connectionIds == null || connectionIds == callIds) { "Every window must cover the same connections" }
        require(idsOfClasses.distinct().size == idsOfClasses.size) { "Window classes must be distinct" }
        require(classIds == null || classIds == idsOfClasses) { "Every window must cover the same classes" }
        classIds = idsOfClasses
        nodeIds = ids
        connectionIds = callIds
        writeKindWindow(
            index,
            sorted.filter {
                it.id !in groupNodeIds
            },
            sortedConnections.filter { it.id !in groupCallIds },
            SeriesPartKind.INSTANCE,
            sortedClasses,
        )
        if (groups.isNotEmpty()) {
            writeKindWindow(
                index,
                sorted.filter { it.id in groupNodeIds },
                sortedConnections.filter { it.id in groupCallIds },
                SeriesPartKind.GROUP,
            )
        }
        nextWindow++
    }

    private fun writeKindWindow(
        index: Int,
        sorted: List<NodeWindow>,
        sortedConnections: List<ConnectionWindow>,
        kind: SeriesPartKind,
        sortedClasses: List<NodeWindow> = emptyList(),
    ) {
        val baseBytes = prefix(index, index + 1, kind).size + PART_SUFFIX_BYTES
        var window = BufferedPart(index, index + 1, kind)
        var splitRows = false

        fun add(
            row: BufferedSeries,
            population: Int,
        ) {
            if (baseBytes + row.singleWindowBytes > maxPartBytes) {
                flushPending(kind)
                val kind = listOf("node", "connection", "class")[population]
                throw ExperimentExecutionException(
                    CoreMessage.SERIES_PART_LIMIT,
                    "$kind=${row.id} window=$index: part size limit $maxPartBytes bytes",
                    mapOf("id" to JsonPrimitive(row.id), "window" to JsonPrimitive(index), "maximum" to JsonPrimitive(maxPartBytes)),
                )
            }
            val group = window.population(population)
            val separator = if (group.isEmpty()) 0 else 1
            if (baseBytes + window.bodyBytes + separator + row.singleWindowBytes > maxPartBytes) {
                flushPending(kind)
                persist(window)
                window = BufferedPart(index, index + 1, kind)
                splitRows = true
            }
            window.add(row, population)
        }
        sorted.forEach { row ->
            add(bufferedSeries(row.id, json.encodeToString(WindowMetrics.serializer(), row.metrics)), population = 0)
        }
        sortedConnections.forEach { row ->
            add(bufferedSeries(row.id, json.encodeToString(ConnectionWindowMetrics.serializer(), row.metrics)), population = 1)
        }
        sortedClasses.forEach { row ->
            add(bufferedSeries(row.id, json.encodeToString(WindowMetrics.serializer(), row.metrics)), population = 2)
        }
        if (splitRows) {
            persist(window)
        } else {
            val current = pending[kind]
            val added =
                listOf(window.nodes, window.connections, window.classes).sumOf { rows ->
                    rows.sumOf { it.windows.single().size + 1 }
                }
            if (current != null &&
                prefix(current.fromWindow, index + 1, kind).size + current.bodyBytes + added + PART_SUFFIX_BYTES <= maxPartBytes
            ) {
                window.nodes.forEachIndexed { node, value -> current.nodes[node].windows += value.windows.single() }
                window.connections.forEachIndexed { connection, value -> current.connections[connection].windows += value.windows.single() }
                window.classes.forEachIndexed { row, value -> current.classes[row].windows += value.windows.single() }
                current.bodyBytes += added
                current.untilWindow = index + 1
            } else {
                flushPending(kind)
                pending[kind] = window
            }
        }
    }

    private fun prefix(
        from: Int,
        until: Int,
        kind: SeriesPartKind,
    ): ByteArray =
        (
            "{\"schemaVersion\":${Versions.SERIES_SCHEMA},\"kind\":\"$kind\",\"profile\":\"${LatencySketch.PROFILE}\"," +
                "\"fromWindow\":$from," +
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

    private fun flushPending(kind: SeriesPartKind) {
        pending.remove(kind)?.let { persist(it) }
    }

    private fun persist(part: BufferedPart) {
        val output = ByteArrayOutputStream()
        val header = prefix(part.fromWindow, part.untilWindow, part.kind)
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
        output.write(CLASSES_PREFIX)
        writeRows(part.classes)
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
                part.kind,
                part.classes.map { it.id },
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
        val kind: SeriesPartKind,
    ) {
        val nodes = mutableListOf<BufferedSeries>()
        val connections = mutableListOf<BufferedSeries>()
        val classes = mutableListOf<BufferedSeries>()

        fun population(index: Int): MutableList<BufferedSeries> =
            when (index) {
                0 -> nodes
                1 -> connections
                else -> classes
            }

        var bodyBytes = 0

        fun add(
            row: BufferedSeries,
            population: Int,
        ) {
            val group = population(population)
            bodyBytes += row.singleWindowBytes + if (group.isEmpty()) 0 else 1
            group += row
        }
    }

    /** Writes the index only after every window has been persisted. */
    fun finish(): SeriesIndex =
        uninterruptedArtifactWrite {
            require(nextWindow == expectedWindows) { "Incomplete series: $nextWindow windows" }
            SeriesPartKind.entries.forEach(::flushPending)
            val index =
                SeriesIndex(
                    schemaVersion = Versions.SERIES_SCHEMA,
                    endMs = endMs,
                    windowMs = windowMs,
                    parts = parts.toList(),
                    groups = groups,
                )
            workspace.create("$directory/index.json", DocumentCodec.encode(SeriesIndex.serializer(), index))
            index
        }

    companion object {
        const val MAX_PART_BYTES = 4 * 1024 * 1024
        private val SUFFIX = "]}".toByteArray(Charsets.UTF_8)
        private val CONNECTIONS_PREFIX = "],\"connections\":[".toByteArray(Charsets.UTF_8)
        private val CLASSES_PREFIX = "],\"classes\":[".toByteArray(Charsets.UTF_8)
        private val PART_SUFFIX_BYTES = CONNECTIONS_PREFIX.size + CLASSES_PREFIX.size + SUFFIX.size
    }
}
