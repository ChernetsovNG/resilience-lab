package resiliencelab.research.ksl

import ksl.simulation.Model
import ksl.utilities.io.OutputDirectory
import java.lang.management.ManagementFactory
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.io.path.bufferedWriter
import kotlin.io.path.createDirectories
import kotlin.io.path.fileSize
import kotlin.io.path.writeText
import kotlin.time.Duration.Companion.minutes

/** One isolated Model per logical replication, with preallocated streams and stable substream index. */
fun createModel(workload: Workload, replication: Int, output: Path): Pair<Model, CapabilityModel> {
    require(replication > 0)
    val model = Model("rep-$replication", output, autoCSVReports = false)
    model.outputDirectory = OutputDirectory(output, autoCreateOutFile = false)
    model.streamProvider.initialSeed(longArrayOf(12345, 12345, 12345, 12345, 12345, 12345))
    val graph = CapabilityModel(model, workload)
    model.numberOfReplications = 1
    model.lengthOfReplication = Double.POSITIVE_INFINITY
    model.resetStartStreamOption = true
    model.numberOfStreamAdvancesPriorToRunning = replication - 1
    model.advanceNextSubStreamOption = true
    model.garbageCollectAfterReplicationFlag = false
    model.maximumAllowedExecutionTimePerReplication = 10.minutes
    return model to graph
}

private fun sha256(path: Path): String {
    val digest = MessageDigest.getInstance("SHA-256")
    Files.newInputStream(path).use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            digest.update(buffer, 0, n)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

internal fun csv(path: Path, rows: List<Map<String, Any>>) {
    require(rows.isNotEmpty())
    val keys = rows.first().keys.toList()
    path.bufferedWriter().use { writer ->
        writer.appendLine(keys.joinToString(","))
        rows.forEach { row -> writer.appendLine(keys.joinToString(",") { row.getValue(it).toString() }) }
    }
}

private fun runReplication(workload: Workload, replication: Int, directory: Path, save: Boolean): Map<String, Any> {
    directory.createDirectories()
    val buildStart = System.nanoTime()
    val (model, graph) = createModel(workload, replication, directory.resolve("ksl"))
    val buildNs = System.nanoTime() - buildStart
    try {
        val start = System.nanoTime()
        model.simulate()
        val simulationNs = System.nanoTime() - start
        val collectStart = System.nanoTime()
        graph.verifyDrained()
        val semanticHash = graph.semanticHash()
        val series = graph.seriesRows().sortedWith(compareBy({ it.responseName }, { it.period }))
        val collectNs = System.nanoTime() - collectStart
        val writeStart = System.nanoTime()
        val seriesPath = directory.resolve("series.csv")
        val tracePath = directory.resolve("trace.csv")
        if (save) {
            if (workload.series) seriesPath.bufferedWriter().use { writer ->
                writer.appendLine("response,period,start,length,value")
                series.forEach { writer.appendLine("${it.responseName},${it.period},${it.startTime},${it.length},${it.value}") }
            }
            if (workload.traceEvery > 0) tracePath.bufferedWriter().use { writer ->
                writer.appendLine("request,node,action,time")
                graph.trace.forEach { writer.appendLine("${it.request},${it.node},${it.action},${it.time}") }
            }
        }
        val writeNs = System.nanoTime() - writeStart
        val hashStart = System.nanoTime()
        val seriesHash = if (save && workload.series) sha256(seriesPath) else "none"
        val traceHash = if (save && workload.traceEvery > 0) sha256(tracePath) else "none"
        val hashNs = System.nanoTime() - hashStart
        return linkedMapOf(
            "replication" to replication,
            "events" to graph.eventsExecuted,
            "build_ms" to buildNs / 1e6,
            "simulation_ms" to simulationNs / 1e6,
            "collection_ms" to collectNs / 1e6,
            "write_ms" to writeNs / 1e6,
            "file_hash_ms" to hashNs / 1e6,
            "client_completions" to graph.clientsCompleted,
            "child_completions" to graph.childrenCompleted,
            "timeouts" to graph.timedOut.count { it },
            "late_children" to graph.lateChildren,
            "last_client_time" to graph.clientEnd.max(),
            "last_child_time" to graph.childEnd.max(),
            "calendar_end_time" to model.time,
            "semantic_sha256" to semanticHash,
            "series_rows" to series.size,
            "trace_rows" to graph.trace.size,
            "series_bytes" to if (save && workload.series) seriesPath.fileSize() else 0,
            "trace_bytes" to if (save && workload.traceEvery > 0) tracePath.fileSize() else 0,
            "series_sha256" to seriesHash,
            "trace_sha256" to traceHash,
        )
    } finally {
        model.outputDirectory.close()
    }
}

private class HeapProbe : AutoCloseable {
    private val bean = ManagementFactory.getMemoryMXBean()
    val peak = AtomicLong(bean.heapMemoryUsage.used)
    private val timer = Executors.newSingleThreadScheduledExecutor { action ->
        Thread(action, "heap-sampler").apply { isDaemon = true }
    }
    init { timer.scheduleAtFixedRate({ peak.accumulateAndGet(bean.heapMemoryUsage.used, ::maxOf) }, 0, 10, TimeUnit.MILLISECONDS) }
    override fun close() { peak.accumulateAndGet(bean.heapMemoryUsage.used, ::maxOf); timer.shutdownNow() }
}

private fun gcCounts(): Pair<Long, Long> = ManagementFactory.getGarbageCollectorMXBeans().let { beans ->
    beans.sumOf { maxOf(0, it.collectionCount) } to beans.sumOf { maxOf(0, it.collectionTime) }
}

/** Direct JVM entry point; Gradle compilation/startup is outside all reported timings. */
fun main(args: Array<String>) {
    require(args.size == 7) { "Usage: BLOCKS REQUESTS none|series|trace|both WORKERS REPLICATIONS WARMUPS OUTPUT" }
    val (blocks, requests) = args.take(2).map(String::toInt)
    val mode = args[2]
    require(mode in setOf("none", "series", "trace", "both"))
    val workers = args[3].toInt()
    val replications = args[4].toInt()
    val warmups = args[5].toInt()
    require(workers > 0 && replications > 0 && warmups >= 0)
    val output = Path.of(args[6]).toAbsolutePath().createDirectories()
    val workload = Workload(blocks, requests, series = mode in setOf("series", "both"), traceEvery = if (mode in setOf("trace", "both")) 100 else 0)
    // Warm up simulation AND export; delete only the two files this warmup created.
    repeat(warmups) {
        val directory = output.resolve("warmup-$it")
        runReplication(workload.copy(requests = minOf(requests, 50_000), observationEnd = minOf(requests, 50_000) * workload.arrivalInterval), 1, directory, true)
        Files.deleteIfExists(directory.resolve("series.csv"))
        Files.deleteIfExists(directory.resolve("trace.csv"))
    }
    System.gc()
    val beforeGc = gcCounts()
    val probe = HeapProbe()
    val started = System.nanoTime()
    val results = Executors.newFixedThreadPool(workers).use { pool ->
        pool.invokeAll((1..replications).map { id -> Callable { runReplication(workload, id, output.resolve("rep-$id"), true) } }).map { it.get() }
    }
    val batchNs = System.nanoTime() - started
    probe.close()
    val afterGc = gcCounts()
    csv(output.resolve("replications.csv"), results)
    val events = results.sumOf { it.getValue("events") as Long }
    csv(output.resolve("summary.csv"), listOf(linkedMapOf(
        "blocks" to blocks, "requests" to requests, "mode" to mode,
        "workers" to workers, "replications" to replications, "warmups" to warmups,
        "events" to events, "batch_ms" to batchNs / 1e6,
        "events_per_second_batch" to events / (batchNs / 1e9),
        "build_ms_sum" to results.sumOf { it.getValue("build_ms") as Double },
        "simulation_ms_sum" to results.sumOf { it.getValue("simulation_ms") as Double },
        "collection_ms_sum" to results.sumOf { it.getValue("collection_ms") as Double },
        "write_ms_sum" to results.sumOf { it.getValue("write_ms") as Double },
        "file_hash_ms_sum" to results.sumOf { it.getValue("file_hash_ms") as Double },
        "heap_sampled_peak_bytes" to probe.peak.get(),
        "gc_count" to afterGc.first - beforeGc.first,
        "gc_ms" to afterGc.second - beforeGc.second,
        "series_rows" to results.sumOf { it.getValue("series_rows") as Int },
        "trace_rows" to results.sumOf { it.getValue("trace_rows") as Int },
        "series_bytes" to results.sumOf { (it.getValue("series_bytes") as Number).toLong() },
        "trace_bytes" to results.sumOf { (it.getValue("trace_bytes") as Number).toLong() },
    )))
    output.resolve("jvm.txt").writeText(listOf(
        "java=${System.getProperty("java.runtime.version")}", "vendor=${System.getProperty("java.vendor")}",
        "os=${System.getProperty("os.name")} ${System.getProperty("os.version")} ${System.getProperty("os.arch")}",
        "processors=${Runtime.getRuntime().availableProcessors()}", "maxHeapBytes=${Runtime.getRuntime().maxMemory()}",
        "jvmArgs=${ManagementFactory.getRuntimeMXBean().inputArguments.joinToString(" ")}",
    ).joinToString("\n", postfix = "\n"))
    println("blocks=$blocks requests=$requests mode=$mode workers=$workers events=$events batchSeconds=${batchNs / 1e9}")
}
