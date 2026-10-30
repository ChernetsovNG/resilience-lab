package resiliencelab.core.execution

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CoreMessage
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

/** Applies S1 timing and S3/S5 storage anchors without constructing a KSL model. */
internal object CostEstimator {
    private data class TaskEstimate(
        val events: Double,
        val rows: Long,
        val rawBytes: Long,
        val artifactBytes: Long,
        val parts: Long,
        val seconds: Double,
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
                if (graph.services.size > 5000) {
                    warnings[CoreMessage.ESTIMATE_EXTRAPOLATION] =
                        EstimateWarning(
                            CoreMessage.ESTIMATE_EXTRAPOLATION,
                            "S1 timing anchors cover 50–5000 services; actual time may differ substantially",
                            mapOf("minServices" to JsonPrimitive(50), "maxServices" to JsonPrimitive(5000)),
                        )
                }
                val perReplication = estimateTask(graph)
                if (perReplication.rawBytes > UI_CACHE_BYTES) {
                    warnings[CoreMessage.ESTIMATE_UI_CACHE] =
                        EstimateWarning(
                            CoreMessage.ESTIMATE_UI_CACHE,
                            "Estimated uncompressed task data exceed the 64 MiB UI cache budget; load selected nodes only",
                            mapOf("cacheMiB" to JsonPrimitive(UI_CACHE_BYTES / (1024 * 1024))),
                        )
                }
                val count = experiment.run.replications
                taskCount = Math.addExact(taskCount, count)
                totalWork += perReplication.seconds * count
                longestTask = maxOf(longestTask, perReplication.seconds)
                events += perReplication.events * count
                rows = Math.addExact(rows, Math.multiplyExact(perReplication.rows, count.toLong()))
                rawBytes = Math.addExact(rawBytes, Math.multiplyExact(perReplication.rawBytes, count.toLong()))
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
        val arrivals = graph.client.arrivalRatePerMs * (graph.run.warmupMs + graph.run.measurementMs)
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
            graph.scenario(service).forEach { step ->
                when (step) {
                    is ServiceStep.Process -> perOriginalRequest += 3.0 * count
                    is ServiceStep.Call -> {
                        val call = graph.call(step.edge)
                        val attempts = count * call.attempts
                        perOriginalRequest += 2.0 * attempts
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
        val rows = Math.multiplyExact((graph.services.size + 1).toLong(), windows.toLong())
        val rawBytes = Math.multiplyExact(rows, BYTES_PER_NODE_WINDOW)
        val parts = ceil(rawBytes.toDouble() / SeriesWriter.MAX_PART_BYTES).toLong().coerceAtLeast(1)
        val compressedBytes = ceil(rawBytes * GZIP_RATIO).toLong()
        val metadataBytes = Math.multiplyExact((graph.services.size + 1).toLong(), 1024)
        val artifactBytes = Math.addExact(Math.addExact(compressedBytes, Math.multiplyExact(parts, 512)), metadataBytes)
        val anchor = timingAnchor(graph.services.size)
        val seconds =
            anchor.interceptSeconds +
                anchor.secondsPerMillionEvents * events / 1_000_000 +
                rows * WRITE_SECONDS_PER_ROW
        return TaskEstimate(events, rows, rawBytes, artifactBytes, parts, seconds)
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

    private const val BYTES_PER_NODE_WINDOW = 512L
    private const val GZIP_RATIO = 0.25
    private const val UI_CACHE_BYTES = 64L * 1024 * 1024
    private const val WRITE_SECONDS_PER_ROW = 7.6316 / 3_000_000
}
