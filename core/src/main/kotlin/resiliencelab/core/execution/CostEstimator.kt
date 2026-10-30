package resiliencelab.core.execution

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.experiment.ReplicaGroupKind
import resiliencelab.core.experiment.ReplicaGroups
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceStep
import resiliencelab.core.ir.windowCount
import resiliencelab.core.results.SeriesWriter
import kotlin.math.ceil
import kotlin.math.max

/** Deterministic pre-run estimate suitable for direct API and CLI output. */
@Serializable
data class ExperimentEstimate(
    val tasks: Int,
    val expectedEvents: Double,
    val expectedRows: Long,
    val workers: Int,
    val estimatedSeconds: Double,
    val estimatedUncompressedBytes: Long,
    val estimatedArtifactBytes: Long,
    val estimatedParts: Long,
    val warnings: List<EstimateWarning>,
)

/**
 * [code] identifies an ADR 0008 budget or a calibration limitation; neither blocks the experiment:
 * - `ESTIMATE_UI_CACHE` — budget: estimated uncompressed task data exceed the 64 MiB decoded UI cache.
 * - `ESTIMATE_EXTRAPOLATION` — calibration: more than 5000 services exceed the measured S1 timing anchors.
 */
@Serializable
data class EstimateWarning(
    val code: String,
    val message: String,
    /** Unformatted scalar values used to translate the warning; absent in older artifacts. */
    val args: Map<String, JsonPrimitive>? = null,
) {
    internal constructor(
        code: CoreMessage,
        message: String,
        args: Map<String, JsonPrimitive> = emptyMap(),
    ) : this(code.code, message, code.args(args))
}

/** Applies S1 timing and S3/S5 storage anchors, recalibrated for graph rows, without constructing a KSL model. */
internal object CostEstimator {
    private data class TaskEstimate(
        val events: Double,
        val rows: Long,
        val rawBytes: Long,
        val artifactBytes: Long,
        val summaryBytes: Long,
        val parts: Long,
        val seconds: Double,
        val storageSource: StorageSource,
        val sourceRows: Long,
    )

    private enum class StorageSource(
        val id: String,
        val description: String,
    ) {
        REPLICAS("replicaInstances", "replica instances and their calls"),
        NODES("nodes", "node rows"),
        CONNECTIONS("connections", "call connection rows"),
        ROUTES("routerOutputs", "router output rows"),
        GROUPS("groups", "replica group rows"),
    }

    private data class StorageRow(
        val bytes: Long,
        val source: StorageSource,
        val group: Boolean = false,
    )

    private data class TimingAnchor(
        val services: Int,
        val interceptSeconds: Double,
        val secondsPerMillionEvents: Double,
    )

    private val timingAnchors =
        listOf(
            TimingAnchor(50, 0.037698, 0.331004),
            TimingAnchor(500, 0.012782, 0.408272),
            TimingAnchor(5000, 0.080353, 1.003791),
        )
    private val speedups = listOf(1 to 1.0, 2 to 1.679, 4 to 2.569, 8 to 3.184)

    fun estimate(
        experiment: CompiledExperiment,
        workers: Int,
    ): ExperimentEstimate {
        require(workers >= 1) { "workers must be at least 1" }
        val warnings = linkedMapOf<CoreMessage, EstimateWarning>()
        var taskCount = 0
        var totalWork = 0.0
        var longestTask = 0.0
        var events = 0.0
        var rows = 0L
        var rawBytes = 0L
        var artifactBytes = 0L
        var parts = 0L
        experiment.variants.forEach { variant ->
            variant.points.forEach { point ->
                val graph = point.graph
                val duration = graph.run.warmupMs + graph.run.measurementMs
                val perReplication = estimateTask(graph)
                val sourceArgs =
                    mapOf(
                        "storageSource" to JsonPrimitive(perReplication.storageSource.id),
                        "sourceRows" to JsonPrimitive(perReplication.sourceRows),
                    )
                val sourceMessage =
                    "Main storage contributor: ${perReplication.storageSource.description} (${perReplication.sourceRows} rows per replication)"
                if (duration >= 3_600_000.0) {
                    val arrivals = graph.client.load.average(duration) * duration
                    warnings[CoreMessage.ESTIMATE_LONG_MODEL_TIME] =
                        EstimateWarning(
                            CoreMessage.ESTIMATE_LONG_MODEL_TIME,
                            "Modelled arrival interval is ${duration / 1_000.0} s with about $arrivals requests per replication; consider a shorter period. $sourceMessage",
                            sourceArgs +
                                mapOf("durationSeconds" to JsonPrimitive(duration / 1_000.0), "arrivals" to JsonPrimitive(arrivals)),
                        )
                }
                if (graph.services.size > 5000) {
                    warnings[CoreMessage.ESTIMATE_EXTRAPOLATION] =
                        EstimateWarning(
                            CoreMessage.ESTIMATE_EXTRAPOLATION,
                            "S1 timing anchors cover 50–5000 services; actual time may differ substantially",
                            mapOf("minServices" to JsonPrimitive(50), "maxServices" to JsonPrimitive(5000)),
                        )
                }
                if (perReplication.rawBytes > UI_CACHE_BYTES) {
                    warnings[CoreMessage.ESTIMATE_UI_CACHE] =
                        EstimateWarning(
                            CoreMessage.ESTIMATE_UI_CACHE,
                            "Estimated uncompressed task data exceed the 64 MiB UI cache budget; load selected nodes only. $sourceMessage",
                            sourceArgs + mapOf("cacheMiB" to JsonPrimitive(UI_CACHE_BYTES / (1024 * 1024))),
                        )
                }
                val count = experiment.run.replications
                taskCount = Math.addExact(taskCount, count)
                totalWork += perReplication.seconds * count
                longestTask = maxOf(longestTask, perReplication.seconds)
                events += perReplication.events * count
                rows = Math.addExact(rows, Math.multiplyExact(perReplication.rows, count.toLong()))
                rawBytes = Math.addExact(rawBytes, Math.multiplyExact(perReplication.rawBytes, count.toLong()))
                artifactBytes = Math.addExact(artifactBytes, perReplication.summaryBytes)
                artifactBytes = Math.addExact(artifactBytes, Math.multiplyExact(perReplication.artifactBytes, count.toLong()))
                parts = Math.addExact(parts, Math.multiplyExact(perReplication.parts, count.toLong()))
            }
        }
        val effectiveWorkers = minOf(workers, taskCount).coerceAtLeast(1)
        val seconds = maxOf(totalWork / speedup(effectiveWorkers), longestTask)
        require(events.isFinite() && events >= 0.0 && seconds.isFinite()) { "Experiment cost estimate exceeds numeric range" }
        return ExperimentEstimate(
            tasks = taskCount,
            expectedEvents = events,
            expectedRows = rows,
            workers = workers,
            estimatedSeconds = seconds,
            estimatedUncompressedBytes = rawBytes,
            estimatedArtifactBytes = artifactBytes,
            estimatedParts = parts,
            warnings = warnings.values.toList(),
        )
    }

    /** Configured attempts give a conservative event estimate; stochastic queue wakeups are not predicted exactly. */
    private fun expectedEvents(graph: GraphIr): Double {
        val duration = graph.run.warmupMs + graph.run.measurementMs
        val arrivals = graph.client.load.average(duration) * duration
        val visits = mutableMapOf(graph.entry to 1.0)
        val services = graph.services.associateBy { it.path }
        val routers = graph.routers.associateBy { it.path }
        var perOriginalRequest = 2.0
        graph.topologicalPaths.forEach { path ->
            val count = visits[path] ?: 0.0
            val router = routers[path]
            if (router != null) {
                val outputs = graph.outgoingRoutes(path)
                val scale = outputs.maxOf { it.weight }
                val weights = outputs.map { if (router.policy == RoutingPolicy.RANDOM) it.weight / scale else 1.0 }
                val total = weights.sum()
                outputs.zip(weights).forEach { (route, weight) ->
                    visits[route.to] = (visits[route.to] ?: 0.0) + count * (weight / total)
                }
                return@forEach
            }
            val service = services.getValue(path)
            if (service.path != graph.entry) perOriginalRequest += 2.0 * count
            // Pooler processing delay is already a Process step; the additional server pool can acquire, expire, and wake.
            if (service.pooler != null) perOriginalRequest += 3.0 * count
            graph.scenario(service).forEach { step ->
                when (step) {
                    is ServiceStep.Process -> perOriginalRequest += 3.0 * count
                    is ServiceStep.Call -> {
                        val call = graph.call(step.edge)
                        val attempts = count * call.attempts
                        perOriginalRequest += 2.0 * attempts
                        // Conservatively allow an acquisition, wait expiry, and queue wakeup for every attempt.
                        if (call.pool != null) perOriginalRequest += 3.0 * attempts
                        visits[call.to] = (visits[call.to] ?: 0.0) + attempts
                    }
                }
            }
        }
        val fixedEvents =
            windowCount(graph.run.warmupMs + graph.run.measurementMs, graph.run.windowMs).toDouble() +
                3.0 + 2.0 * graph.faults.size
        return arrivals * perOriginalRequest + fixedEvents
    }

    private fun estimateTask(graph: GraphIr): TaskEstimate {
        val events = expectedEvents(graph)
        require(events.isFinite() && events >= 0.0) { "Experiment event estimate exceeds numeric range" }
        val windows = windowCount(graph.run.warmupMs + graph.run.measurementMs, graph.run.windowMs)
        val groups = ReplicaGroups.membership(graph)
        val replicaNodes =
            groups
                .filter { it.kind == ReplicaGroupKind.NODE }
                .flatMap { it.instances }
                .map { it.id }
                .toSet()
        val replicaCalls =
            groups
                .filter { it.kind == ReplicaGroupKind.CONNECTION }
                .flatMap { it.instances }
                .map { it.id }
                .toSet()
        val calls = graph.calls.associateBy { it.path }
        val rowKinds =
            buildList {
                add(StorageRow(BYTES_PER_NODE_WINDOW, StorageSource.NODES))
                graph.services.forEach { service ->
                    val sets = if (service.pooler == null) 1 else 2
                    val source = if (service.path in replicaNodes) StorageSource.REPLICAS else StorageSource.NODES
                    add(StorageRow(BYTES_PER_NODE_WINDOW + sets * BYTES_PER_SLOT_POOL, source))
                }
                graph.calls.forEach { call ->
                    val poolBytes = if (call.pool == null) 0 else BYTES_PER_SLOT_POOL
                    val source = if (call.path in replicaCalls) StorageSource.REPLICAS else StorageSource.CONNECTIONS
                    add(StorageRow(BYTES_PER_CONNECTION_WINDOW + poolBytes, source))
                }
                graph.routes.forEach { add(StorageRow(BYTES_PER_CONNECTION_WINDOW, StorageSource.ROUTES)) }
                groups.forEach { group ->
                    val bytes =
                        when (group.kind) {
                            ReplicaGroupKind.NODE -> BYTES_PER_NODE_WINDOW + BYTES_PER_SLOT_POOL + BYTES_PER_REPLICA_EXTREMA
                            ReplicaGroupKind.CONNECTION ->
                                BYTES_PER_CONNECTION_WINDOW +
                                    if (group.instances.any { calls.getValue(it.id).pool != null }) {
                                        BYTES_PER_SLOT_POOL + BYTES_PER_REPLICA_EXTREMA
                                    } else {
                                        0
                                    }
                        }
                    add(StorageRow(bytes, StorageSource.GROUPS, group = true))
                }
            }
        val rows = Math.multiplyExact(rowKinds.size.toLong(), windows.toLong())
        val rawBytes = Math.multiplyExact(rowKinds.sumOf { it.bytes }, windows.toLong())
        // The writer never packs GROUP and INSTANCE rows together, even when both fit in one part.
        val parts =
            rowKinds.groupBy { it.group }.values.sumOf { kind ->
                val bytesPerWindow = kind.sumOf { it.bytes }
                val budget = SeriesWriter.MAX_PART_BYTES.toLong() - PART_OVERHEAD_BYTES
                if (bytesPerWindow > budget) {
                    Math.multiplyExact(Math.ceilDiv(bytesPerWindow, budget), windows.toLong())
                } else {
                    Math.ceilDiv(windows.toLong(), budget / bytesPerWindow)
                }
            }
        val compressedBytes = ceil(rawBytes * GZIP_RATIO).toLong()
        // Replication and summary sketches use a capped population term; actual sketch occupancy is unknown before execution.
        val arrivals =
            graph.client.load.average(graph.run.warmupMs + graph.run.measurementMs) *
                (graph.run.warmupMs + graph.run.measurementMs)
        val bytesPerElement = METADATA_BYTES_PER_ELEMENT + ceil(minOf(arrivals, 2_000.0) * 4).toLong()
        val metadataBytes = Math.multiplyExact(rowKinds.size.toLong(), bytesPerElement)
        // Totals are gzip per replication; each point's aggregate summary remains plain JSON and is counted once.
        val replicationBytes = ceil(metadataBytes * GZIP_RATIO).toLong()
        val artifactBytes = Math.addExact(Math.addExact(compressedBytes, Math.multiplyExact(parts, PART_OVERHEAD_BYTES)), replicationBytes)
        val source = StorageSource.entries.maxBy { source -> rowKinds.filter { it.source == source }.sumOf { it.bytes } }
        val sourceRows = Math.multiplyExact(rowKinds.count { it.source == source }.toLong(), windows.toLong())
        val anchor = timingAnchor(graph.services.size)
        val seconds =
            anchor.interceptSeconds +
                anchor.secondsPerMillionEvents * events / 1_000_000 +
                rows * WRITE_SECONDS_PER_ROW
        return TaskEstimate(events, rows, rawBytes, artifactBytes, metadataBytes, parts, seconds, source, sourceRows)
    }

    private fun timingAnchor(services: Int): TimingAnchor {
        if (services <= timingAnchors.first().services) return timingAnchors.first()
        if (services >= timingAnchors.last().services) return timingAnchors.last()
        timingAnchors.zipWithNext().forEach { (low, high) ->
            if (services in low.services..high.services) {
                val fraction = (services - low.services).toDouble() / (high.services - low.services)
                return TimingAnchor(
                    services,
                    low.interceptSeconds + fraction * (high.interceptSeconds - low.interceptSeconds),
                    low.secondsPerMillionEvents +
                        fraction * (high.secondsPerMillionEvents - low.secondsPerMillionEvents),
                )
            }
        }
        error("No S1 timing anchor for $services services")
    }

    private fun speedup(workers: Int): Double {
        if (workers <= 1) return 1.0
        if (workers >= 8) return 3.184
        speedups.zipWithNext().forEach { (low, high) ->
            if (workers in low.first..high.first) {
                val fraction = (workers - low.first).toDouble() / (high.first - low.first)
                return low.second + fraction * (high.second - low.second)
            }
        }
        return max(1.0, workers.toDouble())
    }

    // Storage anchors checked against retry-storm, checkout, and a replicated graph with pools and a pooler.
    private const val BYTES_PER_NODE_WINDOW = 256L
    private const val BYTES_PER_CONNECTION_WINDOW = 320L
    private const val BYTES_PER_SLOT_POOL = 192L
    private const val BYTES_PER_REPLICA_EXTREMA = 256L
    private const val METADATA_BYTES_PER_ELEMENT = 3_072L
    private const val PART_OVERHEAD_BYTES = 512L
    private const val GZIP_RATIO = 0.125
    private const val UI_CACHE_BYTES = 64L * 1024 * 1024
    private const val WRITE_SECONDS_PER_ROW = 7.6316 / 3_000_000
}
