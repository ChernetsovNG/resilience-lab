package resiliencelab.research.streams

import ksl.utilities.random.rng.RNStreamFactory

private fun corpus(sources: Int, repetitions: Int) = (0 until repetitions).flatMap { replication ->
    (0 until sources).map { StreamKey(42, replication.toLong(), listOf("benchmark", "block$it"), "processing") }
}

private fun usedHeap(): Long = Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()

/** Small reproducible cost probe, separate from simulation and statistical quality checks. */
fun main() {
    System.err.println("java=${System.getProperty("java.version")};vm=${System.getProperty("java.vm.name")};" +
        "os=${System.getProperty("os.name")} ${System.getProperty("os.version")};" +
        "arch=${System.getProperty("os.arch")};processors=${Runtime.getRuntime().availableProcessors()};" +
        "max_heap_bytes=${Runtime.getRuntime().maxMemory()}")
    // Warm hashing, native modular arithmetic and sampling before measured rows.
    repeat(3) {
        val keys = corpus(500, 1)
        StreamPlan(keys).open(keys).values.forEach { stream -> repeat(100) { stream.randU01() } }
    }
    println("phase,sources,replications,address,elapsed_ms,retained_heap_bytes,checksum")
    fun row(phase: String, sources: Int, repetitions: Int, address: Long,
            elapsed: Long, heap: Long = 0, checksum: Long = 0) {
        println("$phase,$sources,$repetitions,$address,${elapsed / 1e6},$heap,$checksum")
    }
    for ((sources, repetitions) in listOf(50 to 1, 500 to 1, 5000 to 1, 5000 to 100)) {
        val keys = corpus(sources, repetitions)
        System.gc()
        val before = usedHeap()
        var start = System.nanoTime()
        val plan = StreamPlan(keys)
        val preflightNs = System.nanoTime() - start
        System.gc()
        val retained = usedHeap() - before
        row("preflight", sources, repetitions, -1, preflightNs, retained,
            plan.addresses.values.fold(0L) { acc, address -> acc xor address })
        if (repetitions == 1) {
            start = System.nanoTime()
            val streams = plan.open(keys)
            row("open", sources, 1, -1, System.nanoTime() - start)
            start = System.nanoTime()
            var checksum = 0L
            streams.values.forEach { stream -> repeat(1000) { checksum = checksum xor stream.randU01().toBits() } }
            row("draw_1000_each", sources, 1, -1, System.nanoTime() - start, checksum = checksum)
        }
    }
    for (address in listOf(0L, 1L, 1L shl 51, Long.MAX_VALUE)) {
        val start = System.nanoTime()
        var checksum = 0L
        repeat(1000) { checksum += streamAt(address).randU01().toBits() }
        row("native_substream_1000", 1, 1, address, System.nanoTime() - start, checksum = checksum)
    }
    for (count in listOf(1000, 10_000, 100_000)) {
        val factory = RNStreamFactory()
        val start = System.nanoTime()
        factory.advanceSeeds(count)
        row("linear_factory_skip", count, 1, -1, System.nanoTime() - start,
            checksum = factory.nextStream().randU01().toBits())
    }
}
