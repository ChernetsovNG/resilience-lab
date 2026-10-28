package resiliencelab.core.results

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.assertj.core.data.Offset.offset
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.engine.ksl.AttemptEvent
import resiliencelab.core.engine.ksl.WindowCollector
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import kotlin.test.Test

class WindowSeriesTest {
    @Test
    fun `consecutive windows fill parts to the byte budget without splitting their nodes`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/packed/series/v/p0/rep-0"
        val rows =
            List(12) { window ->
                listOf("service-a", "service-ё").map { id -> NodeWindow(id, WindowMetrics(window.toDouble(), 1.0, handlers = 1)) }
            }

        fun expected(
            from: Int,
            until: Int,
        ) = SeriesPart(
            fromWindow = from,
            untilWindow = until,
            nodes = rows.first().mapIndexed { node, row -> NodeSeries(row.id, (from until until).map { rows[it][node].metrics }) },
        )
        val json = Json { encodeDefaults = true }

        fun size(part: SeriesPart) = json.encodeToString(SeriesPart.serializer(), part).toByteArray(Charsets.UTF_8).size
        val budget = (0 until 11).maxOf { size(expected(it, it + 2)) }
        val writer = SeriesWriter(workspace, directory, 12.0, 1.0, maxPartBytes = budget)
        rows.forEachIndexed { index, window -> writer.writeWindow(index, window.reversed()) }
        val index = writer.finish()
        assertThat(index.parts).hasSize(6)
        for (part in index.parts) {
            val bytes = GZIPInputStream(workspace.readBytes("$directory/${part.file}").inputStream()).use { it.readAllBytes() }
            assertThat(bytes.size).isEqualTo(part.uncompressedBytes).isLessThanOrEqualTo(budget)
            assertThat(Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8)))
                .isEqualTo(expected(part.fromWindow, part.untilWindow))
            assertThat(part.nodes).containsExactly("service-a", "service-ё")
            if (part.untilWindow < rows.size) assertThat(size(expected(part.fromWindow, part.untilWindow + 1))).isGreaterThan(budget)
        }
    }

    @Test
    fun `queue rejections do not dilute service residence sketches but admitted zero latency remains`() {
        val closed = mutableListOf<List<NodeWindow>>()
        val collector = WindowCollector("client", listOf(service()), 20.0, 10.0) { _, rows -> closed += rows }
        collector.attemptEvent("service", 0.0, AttemptEvent.OFFERED)
        collector.attemptEvent("service", 0.0, AttemptEvent.ADMITTED)
        collector.attemptCompletion("service", 4.0, 4.0, true)
        collector.attemptEvent("service", 5.0, AttemptEvent.OFFERED)
        collector.attemptEvent("service", 5.0, AttemptEvent.ADMITTED)
        collector.attemptCompletion("service", 5.0, 0.0, true)
        repeat(200) {
            collector.attemptEvent("service", 6.0, AttemptEvent.OFFERED)
            collector.attemptEvent("service", 6.0, AttemptEvent.QUEUE_REJECTED)
        }
        repeat(100) {
            collector.attemptEvent("service", 12.0, AttemptEvent.OFFERED)
            collector.attemptEvent("service", 12.0, AttemptEvent.QUEUE_REJECTED)
        }
        collector.finish()
        val mixed = closed[0].single { it.id == "service" }.metrics
        assertThat(mixed.queueRejections).isEqualTo(200)
        assertThat(mixed.latency.count).isEqualTo(2L)
        assertThat(mixed.latency.sumMs).isEqualTo(4.0)
        assertThat(mixed.latency.sketch[0]).isEqualTo(1L)
        assertThat(LatencySketch.fromBins(mixed.latency.sketch).percentile(0.95)!!).isCloseTo(4.0, offset(4.0 / 128))
        val rejected = closed[1].single { it.id == "service" }.metrics
        assertThat(rejected.queueRejections).isEqualTo(100)
        assertThat(rejected.latency.count).isZero()
        assertThat(rejected.latency.sketch).containsExactly(0L)
    }

    @Test
    fun `fractional explicit and default windows share the collector completeness rule`(
        @TempDir root: Path,
    ) {
        listOf(Triple(0.07, 0.01, 7), Triple(0.13, 0.13 / 100, 100)).forEachIndexed { run, (end, step, expected) ->
            val writer = SeriesWriter(FileWorkspace(root), ".results/e/r$run/series/v/p0/rep-0", end, step)
            val collector = WindowCollector("client", listOf(service()), end, step, writer::writeWindow)
            collector.finish()
            val index = writer.finish()
            assertThat(index.parts).hasSize(1)
            assertThat(index.parts.last().untilWindow).isEqualTo(expected)
        }
    }

    @Test
    fun `an interrupted worker persists its current part and retains interruption`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = SeriesWriter(workspace, ".results/e/r/series/v/p0/rep-0", 10.0, 10.0)
        Thread.currentThread().interrupt()
        try {
            writer.writeWindow(0, listOf(NodeWindow("service", WindowMetrics(0.0, 10.0))))
            writer.finish()
            assertThat(Thread.currentThread().isInterrupted).isTrue()
            assertThat(workspace.exists(".results/e/r/series/v/p0/rep-0/index.json")).isTrue()
        } finally {
            Thread.interrupted()
        }
    }

    @Test
    fun `event boundaries warmup and runout use event time and integrate held resources`() {
        val closed = mutableListOf<List<NodeWindow>>()
        val collector = WindowCollector("client", listOf(service()), 25.0, 10.0) { _, rows -> closed += rows }
        collector.originalArrival(0.0)
        collector.busyHandlers("service", 2.0, 1)
        collector.queueLength("service", 4.0, 2)
        collector.originalCompletion(10.0, 10.0, true)
        assertThat(closed).hasSize(1)
        collector.busyHandlers("service", 13.0, 0)
        collector.queueLength("service", 15.0, 0)
        collector.originalCompletion(24.0, 24.0, false)
        collector.originalCompletion(25.0, 25.0, true)
        collector.finish()
        assertThat(closed).hasSize(3)
        val client = closed.map { rows -> rows.first { it.id == "client" }.metrics }
        assertThat(client.map { it.successes }).containsExactly(0, 1, 0)
        assertThat(client.map { it.failures }).containsExactly(0, 0, 1)
        assertThat(client.map { it.durationMs }).containsExactly(10.0, 10.0, 5.0)
        val services = closed.map { rows -> rows.first { it.id == "service" }.metrics }
        assertThat(services.map { it.busyHandlerTimeMs }).containsExactly(8.0, 3.0, 0.0)
        assertThat(services.map { it.queueLengthIntegralMs }).containsExactly(12.0, 10.0, 0.0)
        services.forEach { assertThat(it.busyHandlerTimeMs / (it.handlers * it.durationMs)).isBetween(0.0, 1.0) }
        assertThat(client.sumOf { it.latency.sumMs }).isCloseTo(34.0, offset(1e-12))
    }

    @Test
    fun `parts cover every node and window within four MiB with verifiable checksums`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = SeriesWriter(workspace, ".results/e/r/series/v/p0/rep-0", 20.0, 10.0)
        val rows = List(20_000) { NodeWindow("service-%05d".format(it), WindowMetrics(0.0, 10.0, handlers = 1)) }
        writer.writeWindow(0, rows)
        writer.writeWindow(1, rows.map { it.copy(metrics = it.metrics.copy(startMs = 10.0)) })
        val index = writer.finish()
        assertThat(index.parts.size).isGreaterThan(2)
        val covered = mutableSetOf<Pair<String, Int>>()
        for (part in index.parts) {
            val compressed = workspace.readBytes(".results/e/r/series/v/p0/rep-0/${part.file}")
            assertThat(DocumentVersion.of(compressed)).isEqualTo(part.sha256)
            val bytes = GZIPInputStream(compressed.inputStream()).use { it.readAllBytes() }
            assertThat(bytes.size).isEqualTo(part.uncompressedBytes).isLessThanOrEqualTo(SeriesWriter.MAX_PART_BYTES)
            val decoded = Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8))
            assertThat(decoded.nodes.map { it.id }).isEqualTo(part.nodes)
            assertThat(part.untilWindow - part.fromWindow).isEqualTo(1)
            decoded.nodes.forEach { node ->
                assertThat(node.windows).hasSize(part.untilWindow - part.fromWindow)
                for (window in part.fromWindow until part.untilWindow) assertThat(covered.add(node.id to window)).isTrue()
            }
        }
        assertThat(covered).hasSize(40_000)
        assertThat(workspace.read(".results/e/r/series/v/p0/rep-0/index.json").text).contains("uncompressedBytes")
    }

    @Test
    fun `one oversized node window fails explicitly`(
        @TempDir root: Path,
    ) {
        val writer = SeriesWriter(FileWorkspace(root), ".results/e/r/series/v/p0/rep-0", 10.0, 10.0, maxPartBytes = 100)
        assertThatThrownBy { writer.writeWindow(0, listOf(NodeWindow("service", WindowMetrics(0.0, 10.0)))) }
            .hasMessageContaining("service")
            .hasMessageContaining("window=0")
            .hasMessageContaining("100")
    }

    private fun service() = ServiceNode("service", 1, 10, Distribution(DistributionShape.FIXED, 1.0), 0.0)
}
