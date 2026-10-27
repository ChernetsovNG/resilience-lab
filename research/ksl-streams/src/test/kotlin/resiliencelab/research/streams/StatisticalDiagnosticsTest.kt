package resiliencelab.research.streams

import org.assertj.core.api.Assertions.assertThat
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import ksl.utilities.distributions.ChiSquaredDistribution
import kotlin.math.abs
import kotlin.math.atanh
import kotlin.math.ln
import kotlin.math.sqrt

class StatisticalDiagnosticsTest {
    private data class Check(val name: String, val value: Double, val limit: Double) {
        val passed get() = value.isFinite() && value <= limit
    }
    private fun diagnose(samples: List<DoubleArray>): List<Check> {
        val count = samples.size
        val comparisons = 3 * count + 3 * count * (count - 1) / 2
        val alpha = 1e-6 / comparisons
        val marginalLimit = ChiSquaredDistribution(15.0).invCDF(1.0 - alpha)
        val jointLimit = ChiSquaredDistribution(63.0).invCDF(1.0 - alpha)
        // Conservative normal-tail cutoff; Fisher calibration is asymptotic for uniform pairs.
        val zLimit = sqrt(2.0 * ln(2.0 / alpha))
        fun chiSquared(counts: IntArray, n: Int): Double {
            val expected = n.toDouble() / counts.size
            return counts.sumOf { (it - expected) * (it - expected) / expected }
        }
        fun correlationZ(x: DoubleArray, y: DoubleArray, lag: Int): Double {
            val n = x.size - lag
            var sx = 0.0; var sy = 0.0; var xx = 0.0; var yy = 0.0; var xy = 0.0
            for (k in 0 until n) {
                val a = x[k + lag]; val b = y[k]
                sx += a; sy += b; xx += a * a; yy += b * b; xy += a * b
            }
            val r = (xy - sx * sy / n) / sqrt((xx - sx * sx / n) * (yy - sy * sy / n))
            return atanh(abs(r).coerceAtMost(1.0)) * sqrt(n - 3.0)
        }
        return buildList {
            for ((i, x) in samples.withIndex()) {
                val counts = IntArray(16)
                x.forEach { counts[(it * 16).toInt()]++ }
                add(Check("marginal-$i", chiSquared(counts, x.size), marginalLimit))
                for (lag in listOf(1, 17)) add(Check("serial$lag-$i", correlationZ(x, x, lag), zLimit))
                for (j in 0 until i) {
                    val y = samples[j]
                    val joint = IntArray(64)
                    for (k in x.indices) joint[(x[k] * 8).toInt() * 8 + (y[k] * 8).toInt()]++
                    add(Check("joint-$j-$i", chiSquared(joint, x.size), jointLimit))
                    add(Check("correlation-$j-$i", correlationZ(x, y, 0), zLimit))
                    add(Check("lag17-$j-$i", correlationZ(y, x, 17), zLimit))
                }
            }
        }
    }

    @Test
    fun `fixed corpus passes marginal serial and cross-source diagnostics`() {
        val keys = (0 until 32).map {
            StreamKey((it % 4).toLong(), (it % 3).toLong(), listOf("diagnostics", "block$it"), roles[it % 3])
        }
        val streams = StreamPlan(keys).open(keys)
        val samples = keys.map { key -> DoubleArray(65_536) { streams.getValue(key).randU01() } }
        val checks = diagnose(samples)
        Files.createDirectories(Path.of("build"))
        Files.writeString(Path.of("build/diagnostics.csv"),
            "name,value,limit,passed\n" + checks.joinToString("\n") { "${it.name},${it.value},${it.limit},${it.passed}" } + "\n")
        assertThat(checks).hasSize(1584)
        assertThat(checks.filterNot { it.passed }).isEmpty()
    }

    @Test
    fun `diagnostics detect duplicate complement constant and shifted streams`() {
        val source = streamAt(5391452259724126168)
        val x = DoubleArray(65_536) { source.randU01() }
        assertThat(diagnose(listOf(x)).filterNot { it.passed }).isEmpty()
        val controls = listOf(x.copyOf(), DoubleArray(x.size) { 1.0 - x[it] },
            DoubleArray(x.size) { 0.5 }, DoubleArray(x.size) { x[(it + 17) % x.size] })
        val expectedDetectors = listOf("correlation-0-1", "correlation-0-1", "marginal-1", "lag17-0-1")
        for ((index, control) in controls.withIndex()) {
            val detector = diagnose(listOf(x, control)).single { it.name == expectedDetectors[index] }
            assertThat(detector.passed).describedAs("negative control %s, %s", index, detector.name).isFalse()
        }
    }

    @Test
    fun `five thousand addressed sources have no duplicate 64-draw prefixes`() {
        val keys = (0 until 5000).map { StreamKey(42, 0, listOf("wide", "block$it"), "processing") }
        val plan = StreamPlan(keys)
        assertThat(plan.addresses.values.toSet()).hasSize(5000)
        val prefixes = plan.open(keys).values.map { stream -> List(64) { stream.randU01().toBits() } }
        assertThat(prefixes.toSet()).hasSize(5000)
    }
}
