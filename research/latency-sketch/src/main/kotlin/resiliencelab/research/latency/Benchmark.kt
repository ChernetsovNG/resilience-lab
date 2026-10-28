package resiliencelab.research.latency

import com.datadoghq.sketch.ddsketch.mapping.LogarithmicMapping
import ksl.utilities.statistic.Statistic
import kotlinx.serialization.json.*
import org.openjdk.jol.info.GraphLayout
import java.io.File
import java.lang.management.ManagementFactory
import java.security.MessageDigest
import java.util.SplittableRandom
import java.util.zip.GZIPOutputStream
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.system.measureNanoTime

val probabilities = listOf(0.001, 0.01, 0.1, 0.5, 0.9, 0.95, 0.99, 0.999)

fun json(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.associate { it.key.toString() to json(it.value) })
    is Iterable<*> -> JsonArray(value.map(::json))
    is DoubleArray -> JsonArray(value.map(::JsonPrimitive))
    else -> error("Unsupported JSON value: " + value.javaClass)
}

fun writeJson(file: File, value: Any?) = file.writeText(json(value).toString() + "\n")
fun bits(value: Double?): String? = value?.toRawBits()?.toULong()?.toString(16)?.padStart(16, '0')
fun error(actual: Double, expected: Double): Double = if (expected == 0.0) {
    check(actual == 0.0) { "Zero must stay exact" }; 0.0
} else abs(actual - expected) / expected

fun collect(values: DoubleArray, factory: () -> Collector = { LibrarySketch() }): Collector =
    factory().also { sketch -> values.forEach { sketch.add(it) } }

fun samples(n: Int, seed: Long): DoubleArray {
    val random = SplittableRandom(seed)
    return DoubleArray(n) { i ->
        when {
            i % 31 == 0 -> 0.0
            i % 17 == 0 -> 60000.0
            else -> exp(ln(0.001) + random.nextDouble() * ln(60000.0 / 0.001))
        }
    }
}

fun quantileBits(bins: Bins): List<String?> = probabilities.map { bits(bins.percentile(it)) }

fun verify(output: File) {
    val boundaries = (-637..1015).flatMap { index ->
        val x = PortableMapping.lowerBound(index)
        listOf(Math.nextDown(x), x, Math.nextUp(x))
    }.toDoubleArray()
    val cases = linkedMapOf(
        "empty" to doubleArrayOf(),
        "zeros" to DoubleArray(100),
        "singleton" to doubleArrayOf(0.125),
        "gap" to (DoubleArray(19) { 1.0 } + 1000.0),
        "zero-gap" to (DoubleArray(19) + 1000.0),
        "fixed" to DoubleArray(1000) { 60_000.0 },
        "mixed" to samples(20_000, 67),
        "boundaries" to boundaries,
    )
    val accuracy = mutableListOf<Map<String, Any?>>()
    for ((name, values) in cases) {
        if (values.isEmpty()) continue
        for ((implementation, factory) in factories) {
            val sketch = collect(values, factory)
            val bins = sketch.bins()
            var maxError = 0.0
            // Many ranks, including p95/p99, checked against the CURRENT KSL definition.
            for (p in (1..999).map { it / 1000.0 } + probabilities) {
                val exact = Statistic.percentile(values.copyOf(), p)
                maxError = maxOf(maxError, error(bins.percentile(p, sketch::representative)!!, exact))
            }
            check(maxError <= 0.010000000001) { implementation + ": accuracy " + maxError }
            accuracy += mapOf("case" to name, "implementation" to implementation,
                "observations" to values.size, "bins" to bins.positive.size, "maxRelativeError" to maxError)
        }
    }
    // Merge windows, then nodes and replications in different orders and tree shapes.
    val values = samples(120_000, 20261028)
    val windows = Array(600) { LibrarySketch(sparse = it % 2 == 0) }
    values.forEachIndexed { i, x -> windows[i % windows.size].add(x) }
    val direct = collect(values).bins().json()
    val orders = listOf(windows.indices.toList(), windows.indices.reversed().toList()) +
        (0..11).map { windows.indices.shuffled(kotlin.random.Random(it)) }
    for (order in orders) {
        val merged = LibrarySketch()
        order.forEach { merged.merge(windows[it]) }
        check(merged.bins().json() == direct) { "Merge order mismatch" }
    }
    fun tree(parts: List<LibrarySketch>): LibrarySketch {
        if (parts.size == 1) return LibrarySketch().also { it.merge(parts[0]) }
        val half = parts.size / 2
        return tree(parts.take(half)).also { it.merge(tree(parts.drop(half))) }
    }
    check(tree(windows.toList()).bins().json() == direct)
    val nodes = windows.toList().chunked(20).map(::tree)
    val replications = nodes.chunked(5).map(::tree)
    check(tree(replications.reversed()).bins().json() == direct)
    check(collect(values.reversedArray()).bins().json() == direct)
    // Error paths must be atomic; no silent collapse or nonzero-to-zero rounding.
    val guarded = LibrarySketch().also { it.add(1.0) }
    val before = guarded.bins().json()
    for (x in listOf(Double.NaN, Double.POSITIVE_INFINITY, -1.0, Double.MIN_VALUE, Math.scalb(1.0, 40))) {
        check(runCatching { guarded.add(x) }.isFailure)
        check(guarded.bins().json() == before)
    }
    check(runCatching { guarded.merge(LibrarySketch().also { it.add(Math.scalb(1.0, 40)) }) }.isFailure)
    check(guarded.bins().json() == before)
    check(runCatching { guarded.merge(LibrarySketch(LogarithmicMapping(0.01))) }.isFailure)
    val huge = LibrarySketch().also { it.add(1.0, MAX_COUNT - 1) }
    huge.merge(LibrarySketch().also { it.add(0.0) })
    val hugeBefore = huge.bins().json()
    check(runCatching { huge.add(1.0) }.isFailure)
    check(huge.bins().json() == hugeBefore)
    check(huge.bins().count == MAX_COUNT)
    val fixtures = cases.map { (name, data) ->
        val bins = collect(data).bins()
        mapOf("name" to name, "values" to data, "sketch" to bins.array(),
            "probabilities" to probabilities, "quantileBits" to quantileBits(bins))
    }
    val merged = collect(values).bins()
    val payload = linkedMapOf<String, Any?>("profile" to PROFILE,
        "windows" to windows.map { it.bins().array() }, "merged" to merged.array(),
        "probabilities" to probabilities, "mergedQuantileBits" to quantileBits(merged))
    writeJson(File(output, "fixtures.json"), payload + ("cases" to fixtures))
    writeJson(File(output, "selected-ui.json"), payload)
    GZIPOutputStream(File(output, "selected-ui.json.gz").outputStream()).use {
        it.write(File(output, "selected-ui.json").readBytes())
    }
    writeJson(File(output, "accuracy.json"), accuracy)
    val gap = cases.getValue("gap")
    val native = collect(gap) as LibrarySketch
    writeJson(File(output, "verification.json"), mapOf("profile" to PROFILE,
        "accuracyCases" to accuracy.size, "probabilitiesPerCase" to 999 + probabilities.size,
        "mergeOrders" to orders.size, "mergeTreeShapes" to 2, "mergeObservations" to values.size,
        "guards" to "invalid, underflow, span, profile, count; atomic rejection",
        "gapExample" to probabilities.takeLast(3).map { p -> mapOf("p" to p,
            "kslExact" to Statistic.percentile(gap.copyOf(), p),
            "nativeRank" to native.libraryPercentile(p), "preservedRank" to native.bins().percentile(p)) }))
}

fun memoryAndInsert(output: File) {
    val data = samples(400_000, 77)
    val rows = mutableListOf<Map<String, Any?>>()
    for ((name, factory) in factories) {
        repeat(3) { collect(data, factory) }
        for (trial in 0..6) {
            val sketch = factory()
            val elapsed = measureNanoTime { data.forEach { sketch.add(it) } }
            rows += mapOf("implementation" to name, "trial" to trial, "observations" to data.size,
                "nanosecondsPerAdd" to elapsed.toDouble() / data.size,
                "bins" to sketch.bins().positive.size,
                "objectGraphBytes" to GraphLayout.parseInstance(sketch).totalSize())
        }
    }
    writeJson(File(output, "insert.json"), rows)
    writeJson(File(output, "memory.json"), listOf(0, 1, 6, 40, 400).flatMap { n ->
        factories.map { (name, factory) ->
            val sketch = collect(samples(n, 47), factory)
            mapOf("implementation" to name, "observations" to n, "bins" to sketch.bins().positive.size,
                "objectGraphBytes" to GraphLayout.parseInstance(sketch).totalSize(),
                "jsonBytes" to sketch.bins().json().toByteArray().size)
        }
    })
}

fun main(args: Array<String>) {
    require(args.size >= 2) { "Usage: verify|measure|sizes|retry|s1 <output-directory> [repository|blocks requests]" }
    val output = File(args[1]).absoluteFile.also { it.mkdirs() }
    when (args[0]) {
        "verify" -> verify(output)
        "measure" -> memoryAndInsert(output)
        "sizes" -> sizes(output)
        "retry" -> retryStorm(output, File(args[2]))
        "s1" -> s1(output, args[2].toInt(), args[3].toInt())
        else -> error("Unknown mode")
    }
    writeJson(File(output, "environment.json"), mapOf("javaVersion" to System.getProperty("java.version"),
        "vm" to System.getProperty("java.vm.name"), "os" to System.getProperty("os.name"),
        "osVersion" to System.getProperty("os.version"), "arch" to System.getProperty("os.arch"),
        "processors" to Runtime.getRuntime().availableProcessors(),
        "jvmFlags" to ManagementFactory.getRuntimeMXBean().inputArguments))
    println(args[0] + ": PASS")
}

fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
        val buffer = ByteArray(65536)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            digest.update(buffer, 0, n)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}
