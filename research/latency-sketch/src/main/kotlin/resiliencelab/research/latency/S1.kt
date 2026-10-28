package resiliencelab.research.latency

import java.io.File
import java.io.FilterOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.zip.GZIPOutputStream
import org.openjdk.jol.info.GraphLayout
import resiliencelab.research.ksl.Workload
import resiliencelab.research.ksl.createModel
import kotlin.system.measureNanoTime

private const val S1_WINDOWS = 600
private data class Observation(val window: Int, val value: Double)
private data class PendingVisit(val queued: Double, var acquired: Boolean = false)
private data class Dataset(
    val nodes: Map<String, List<Observation>>,
    val simulationNs: Long,
    val executedEvents: Long,
    val traceRecords: Int,
    val semanticSha256: String,
)

private fun s1Dataset(output: File, blocks: Int, requests: Int): Dataset {
    val workload = Workload(blocks = blocks, requests = requests, traceEvery = 1, windows = S1_WINDOWS)
    val (model, graph) = createModel(workload, 1, File(output, "ksl").toPath())
    try {
        val simulationNs = measureNanoTime { model.simulate() }
        graph.verifyDrained()
        val nodes = graph.resources.map { it.name }.sorted().associateWith { mutableListOf<Observation>() }
        val pending = mutableMapOf<Pair<Int, String>, PendingVisit>()
        var releases = 0L
        for (row in graph.trace) {
            val key = row.request to row.node
            when (row.action) {
                "queue" -> check(pending.put(key, PendingVisit(row.time)) == null) { "Repeated queue: $key" }
                "acquire" -> {
                    val visit = pending.getValue(key)
                    check(!visit.acquired) { "Repeated acquire: $key" }
                    visit.acquired = true
                }
                "release" -> {
                    val visit = requireNotNull(pending.remove(key)) { "Release without queue: $key" }
                    check(visit.acquired) { "Release without acquire: $key" }
                    val latency = row.time - visit.queued
                    validateValue(latency)
                    val window = (row.request.toLong() * S1_WINDOWS / requests).toInt()
                    nodes.getValue(row.node).add(Observation(window, latency))
                    releases++
                }
            }
        }
        check(pending.isEmpty()) { "Unfinished resource visits" }
        check(releases == 6L * requests) { "Expected six resource visits per original request" }
        check(nodes.size == blocks)
        val traceRecords = graph.trace.size
        graph.trace.clear()
        return Dataset(nodes, simulationNs, graph.eventsExecuted, traceRecords, graph.semanticHash())
    } finally {
        model.outputDirectory.close()
    }
}

private fun windowCollectors(rows: List<Observation>, factory: () -> Collector): Array<Collector?> {
    val windows = arrayOfNulls<Collector>(S1_WINDOWS)
    for (row in rows) {
        val sketch = windows[row.window] ?: factory().also { windows[row.window] = it }
        sketch.add(row.value)
    }
    return windows
}

private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

private fun fingerprint(digest: MessageDigest, node: String, windows: Array<Collector?>) {
    val scratch = ByteBuffer.allocate(8)
    fun number(value: Long) { scratch.clear(); scratch.putLong(value); digest.update(scratch.array()) }
    val name = node.toByteArray(Charsets.UTF_8)
    number(name.size.toLong())
    digest.update(name)
    for ((window, sketch) in windows.withIndex()) {
        if (sketch == null) continue
        val bins = sketch.bins()
        number(window.toLong())
        number(bins.zero)
        number(bins.positive.size.toLong())
        for ((index, count) in bins.positive.toSortedMap()) {
            number(index.toLong()); number(count)
        }
    }
    number(-1)
}

private fun s1Measurements(dataset: Dataset): List<Map<String, Any?>> {
    val observations = dataset.nodes.values.sumOf { it.size.toLong() }
    return factories.map { (name, factory) ->
        val trials = mutableListOf<Map<String, Any?>>()
        var expectedHash: String? = null
        repeat(7) { pass ->
            val digest = MessageDigest.getInstance("SHA-256")
            var elapsed = 0L
            for ((node, rows) in dataset.nodes) {
                val start = System.nanoTime()
                val windows = windowCollectors(rows, factory)
                elapsed += System.nanoTime() - start
                fingerprint(digest, node, windows)
            }
            val hash = hex(digest.digest())
            check(expectedHash == null || expectedHash == hash) { "$name replay changed" }
            expectedHash = hash
            if (pass >= 2) trials += mapOf("trial" to pass - 2, "nanoseconds" to elapsed,
                "nanosecondsPerObservation" to elapsed.toDouble() / observations,
                "observationsPerSecond" to observations * 1e9 / elapsed, "sha256" to hash)
        }
        val sampleRows = dataset.nodes.entries.take(5)
        val sample = sampleRows.map { windowCollectors(it.value, factory) }
        val graphBytes = GraphLayout.parseInstance(sample).totalSize()
        val slots = sample.size * S1_WINDOWS
        mapOf("implementation" to name, "warmupPasses" to 2, "measuredPasses" to 5,
            "trials" to trials, "sha256" to expectedHash,
            "memorySample" to mapOf("nodeIds" to sampleRows.map { it.key }, "windowSlots" to slots,
                "populatedWindows" to sample.sumOf { windows -> windows.count { it != null } },
                "objectGraphBytes" to graphBytes, "bytesPerWindowSlot" to graphBytes.toDouble() / slots,
                "scope" to "First up to five sorted nodes; list, 600-slot arrays and lazily populated collectors"))
    }
}

private class CountedOutput(output: OutputStream) : FilterOutputStream(output) {
    var count = 0L
        private set
    val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
    override fun write(value: Int) { out.write(value); count++; digest.update(value.toByte()) }
    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        out.write(bytes, offset, length)
        count += length
        digest.update(bytes, offset, length)
    }
}

private fun s1Series(output: File, blocks: Int, requests: Int, dataset: Dataset): Map<String, Any> {
    val path = "series/s1/b$blocks-n$requests/rep-1.json.gz"
    val file = File(output, path).also { it.parentFile.mkdirs() }
    val counted = CountedOutput(GZIPOutputStream(file.outputStream().buffered()))
    counted.bufferedWriter(Charsets.UTF_8).use { writer ->
        writer.append("{\"profile\":").append(json(PROFILE).toString()).append(",\"nodes\":[")
        dataset.nodes.entries.forEachIndexed { index, (node, rows) ->
            if (index > 0) writer.append(',')
            writer.append("{\"id\":").append(json(node).toString()).append(",\"windows\":[")
            windowCollectors(rows) { LibrarySketch() }.forEachIndexed { window, collector ->
                if (window > 0) writer.append(',')
                writer.append(collector?.bins()?.json() ?: "[0]")
            }
            writer.append("]}")
        }
        writer.append("]}\n")
    }
    return mapOf("path" to path, "rawBytes" to counted.count, "gzipBytes" to file.length(),
        "jsonSha256" to hex(counted.digest.digest()), "sha256" to sha256(file))
}

/** Replays actual S1 resource visits; ordinal cohorts define windows and retain all run-out. */
fun s1(output: File, blocks: Int, requests: Int) {
    val dataset = s1Dataset(output, blocks, requests)
    var emptyWindows = 0L
    var zeros = 0L
    for (rows in dataset.nodes.values) {
        val counts = IntArray(S1_WINDOWS)
        for (row in rows) { counts[row.window]++; if (row.value == 0.0) zeros++ }
        emptyWindows += counts.count { it == 0 }
    }
    val observations = dataset.nodes.values.sumOf { it.size.toLong() }
    val measurements = s1Measurements(dataset)
    val series = s1Series(output, blocks, requests, dataset)
    writeJson(File(output, "s1-$blocks-$requests.json"), mapOf("profile" to PROFILE,
        "blocks" to blocks, "requests" to requests, "replication" to 1, "windowsPerNode" to S1_WINDOWS,
        "latencyUnit" to "S1 simulation time units",
        "observation" to "Actual resource visit: release time minus queue-entry time, including waiting and holding",
        "windowAssignment" to "Original-request ordinal cohort: floor(requestOrdinal*600/requests); all run-out retained",
        "windowTimeSemantics" to "Cohort assignment only; these are not TimeSeriesResponse time averages",
        "observations" to observations, "zeroObservations" to zeros,
        "emptyWindows" to emptyWindows, "totalWindowSlots" to blocks.toLong() * S1_WINDOWS,
        "simulationWithFullTraceNs" to dataset.simulationNs, "executedEvents" to dataset.executedEvents,
        "traceRecords" to dataset.traceRecords, "semanticSha256" to dataset.semanticSha256,
        "timingIncludes" to "Per-node allocation of 600 slots, lazy collector construction, window dispatch and add",
        "timingExcludes" to "KSL and trace generation, trace parsing, fingerprints, JOL and serialization",
        "timingRetention" to "One node's collectors at a time; all original observations retained for replay",
        "measurements" to measurements, "series" to series))
}
