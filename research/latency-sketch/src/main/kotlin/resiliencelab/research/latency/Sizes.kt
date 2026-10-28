package resiliencelab.research.latency

import java.io.File
import java.util.SplittableRandom
import java.util.zip.GZIPOutputStream

/** Fully populated stress data, separate from sparse real S1 measurements. No request samples are invented. */
fun sizes(output: File) {
    val rows = mutableListOf<Map<String, Any?>>()
    for (nodes in listOf(50, 500, 5000)) {
        val file = File(output, "stress-" + nodes + ".json.gz")
        var rawBytes = 0L
        val started = System.nanoTime()
        GZIPOutputStream(file.outputStream().buffered()).use { gzip ->
            fun emit(text: String) {
                val bytes = text.toByteArray(Charsets.UTF_8)
                rawBytes += bytes.size
                gzip.write(bytes)
            }
            emit("{\"profile\":\"" + PROFILE + "\",\"nodes\":[")
            for (node in 0 until nodes) {
                if (node > 0) emit(",")
                emit("{\"id\":\"n" + node + "\",\"windows\":[")
                val random = SplittableRandom(67000L + node)
                for (window in 0 until 600) {
                    if (window > 0) emit(",")
                    // Sixteen occupied bins spread over ~24 octaves, varied integer counts.
                    val bins = (0 until 16).associate { bin ->
                        (-600 + bin * 100 + random.nextInt(50)) to random.nextLong(1, 401)
                    }
                    emit(Bins(random.nextLong(0, 21), bins).json())
                }
                emit("]}")
            }
            emit("]}")
        }
        rows += linkedMapOf("profile" to "dense-16-bins", "nodes" to nodes, "windows" to 600,
            "rawBytes" to rawBytes, "gzipBytes" to file.length(), "sha256" to sha256(file),
            "rawBytesPerNodeWindow" to rawBytes.toDouble() / (nodes * 600),
            "part64MiBCompressed" to (file.length() <= 64L * 1024 * 1024),
            "ui4MiBCompressed" to (file.length() <= 4L * 1024 * 1024),
            "writeSeconds" to (System.nanoTime() - started) / 1e9)
        println("stress nodes=" + nodes + " gzipBytes=" + file.length())
    }
    writeJson(File(output, "sizes.json"), rows)
}
