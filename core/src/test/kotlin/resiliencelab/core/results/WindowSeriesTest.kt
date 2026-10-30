package resiliencelab.core.results

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.assertj.core.data.Offset.offset
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.engine.ksl.AttemptEvent
import resiliencelab.core.engine.ksl.WindowCollector
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.LatencyStatistics
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import kotlin.test.Test

class WindowSeriesTest {
    @OptIn(ExperimentalSerializationApi::class)
    private val partJson =
        Json {
            encodeDefaults = true
            explicitNulls = false
        }

    @Test
    fun `capacity changes never fragment unrelated call occupancy integrals`() {
        fun collect(changes: Boolean): ConnectionWindowMetrics {
            val closed = mutableListOf<ConnectionWindow>()
            val collector =
                WindowCollector(
                    "client",
                    emptyList(),
                    10.0,
                    10.0,
                    connectionIds = listOf("call"),
                    connectionPoolSizes = mapOf("call" to 3),
                    onWindow = { _, _, calls -> closed += calls },
                )
            repeat(3) { collector.connectionEvent("call", 0.1, resiliencelab.core.engine.ksl.ConnectionEvent.SENT, 0.0) }
            if (changes) for (event in 2..99) collector.slotCapacity("call", "pool", event * 0.1, 2 + event % 2)
            repeat(3) { collector.connectionEvent("call", 9.97, resiliencelab.core.engine.ksl.ConnectionEvent.SUCCEEDED, 0.0) }
            collector.finish()
            return closed.single().metrics
        }
        assertThat(collect(true).inFlightIntegralMs).isEqualTo(collect(false).inFlightIntegralMs)
    }

    @Test
    fun `constant slot capacity uses one exact window duration product despite fractional work events`() {
        val closed = mutableListOf<NodeWindow>()
        val collector =
            WindowCollector(
                "client",
                listOf(service().copy(handlers = 3)),
                10.0,
                10.0,
                onWindow = { _, nodes, _ -> closed += nodes },
            )
        repeat(100) { collector.busyHandlers("service", it * 0.1, it % 3) }
        collector.finish()
        assertThat(
            closed
                .single { it.id == "service" }
                .metrics.slotPools
                .getValue("handlers")
                .capacityIntegralMs,
        ).isEqualTo(30.0)
    }

    @Test
    fun `packed series use schema five with slot maps and connection coverage`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/r/series/v/p0/rep-0"
        val writer = SeriesWriter(workspace, directory, 1.0, 1.0)
        writer.writeWindow(
            0,
            listOf(NodeWindow("service", WindowMetrics(0.0, 1.0))),
            listOf(ConnectionWindow("call", ConnectionWindowMetrics(0.0, 1.0))),
        )
        val index = writer.finish()
        val bytes = GZIPInputStream(workspace.readBytes("$directory/${index.parts.single().file}").inputStream()).use { it.readAllBytes() }
        assertThat(bytes.toString(Charsets.UTF_8)).doesNotContain("\"pooler\"")
        assertThat(index.schemaVersion).isEqualTo(5)
        val part = Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8))
        assertThat(part.schemaVersion).isEqualTo(5)
        assertThat(part.connections.map { it.id }).containsExactly("call")
        val persistedIndex = Json.decodeFromString(SeriesIndex.serializer(), workspace.read("$directory/index.json").text)
        assertThat(persistedIndex.parts.single().connections).containsExactly("call")
    }

    @Test
    fun `mixed consecutive windows count exact UTF-8 bytes across both arrays`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/mixed/series/v/p0/rep-0"
        val rows = List(8) { window -> listOf(NodeWindow("service-ё", WindowMetrics(window.toDouble(), 1.0))) }
        val connections =
            List(8) { window ->
                listOf("call-ё\n\"", "service-ё").map { id ->
                    ConnectionWindow(
                        id,
                        ConnectionWindowMetrics(
                            window.toDouble(),
                            1.0,
                            sentAttempts = 4,
                            retries = 2,
                            succeeded = 1,
                            failed = 1,
                            timeouts = 2,
                            orphaned = 1,
                            inFlightIntegralMs = 1.5,
                            orphanedIntegralMs = 0.5,
                            backoffIntegralMs = 0.25,
                            latency = LatencyStatistics(1, 0.0, listOf(1)),
                        ),
                    )
                }
            }

        fun expected(
            from: Int,
            until: Int,
        ) = SeriesPart(
            fromWindow = from,
            untilWindow = until,
            nodes = listOf(NodeSeries(rows[0][0].id, (from until until).map { rows[it][0].metrics })),
            connections =
                connections[0].mapIndexed { connection, row ->
                    ConnectionSeries(row.id, (from until until).map { connections[it][connection].metrics })
                },
        )
        val budget = (0 until 7).maxOf { partBytes(expected(it, it + 2)).size }
        val writer = SeriesWriter(workspace, directory, 8.0, 1.0, maxPartBytes = budget)
        rows.forEachIndexed { index, window -> writer.writeWindow(index, window, connections[index].reversed()) }
        val index = writer.finish()
        assertThat(index.parts).hasSize(4)
        index.parts.forEach { part ->
            val bytes = GZIPInputStream(workspace.readBytes("$directory/${part.file}").inputStream()).use { it.readAllBytes() }
            assertThat(bytes).isEqualTo(partBytes(expected(part.fromWindow, part.untilWindow)))
            assertThat(bytes.size).isEqualTo(part.uncompressedBytes).isLessThanOrEqualTo(budget)
            assertThat(DocumentVersion.of(workspace.readBytes("$directory/${part.file}"))).isEqualTo(part.sha256)
            assertThat(part.connections).containsExactly("call-ё\n\"", "service-ё")
            if (part.untilWindow < rows.size) {
                assertThat(partBytes(expected(part.fromWindow, part.untilWindow + 1)).size).isGreaterThan(budget)
            }
        }
    }

    @Test
    fun `split windows cover nodes and connections once with mixed and connection-only parts`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/split/series/v/p0/rep-0"
        val nodes = List(5) { NodeWindow("row-$it", WindowMetrics(0.0, 1.0)) }
        val connections = List(5) { ConnectionWindow("row-$it", ConnectionWindowMetrics(0.0, 1.0)) }

        fun part(
            rows: List<NodeWindow>,
            calls: List<ConnectionWindow>,
        ) = SeriesPart(
            fromWindow = 0,
            untilWindow = 1,
            nodes = rows.map { NodeSeries(it.id, listOf(it.metrics)) },
            connections = calls.map { ConnectionSeries(it.id, listOf(it.metrics)) },
        )
        val budget =
            maxOf(
                partBytes(part(nodes.take(2), emptyList())).size,
                partBytes(part(nodes.takeLast(1), connections.take(1))).size,
                partBytes(part(emptyList(), connections.take(2))).size,
            )
        val writer = SeriesWriter(workspace, directory, 2.0, 1.0, maxPartBytes = budget)
        repeat(2) { window ->
            writer.writeWindow(
                window,
                nodes.map { it.copy(metrics = it.metrics.copy(startMs = window.toDouble())) }.reversed(),
                connections.map { it.copy(metrics = it.metrics.copy(startMs = window.toDouble())) }.reversed(),
            )
        }
        val index = writer.finish()
        val coveredNodes = mutableSetOf<Pair<String, Int>>()
        val coveredConnections = mutableSetOf<Pair<String, Int>>()
        val decoded =
            index.parts.map { reference ->
                val bytes = GZIPInputStream(workspace.readBytes("$directory/${reference.file}").inputStream()).use { it.readAllBytes() }
                assertThat(bytes.size).isEqualTo(reference.uncompressedBytes).isLessThanOrEqualTo(budget)
                Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8)).also { part ->
                    assertThat(part.nodes.map { it.id }).isEqualTo(reference.nodes)
                    assertThat(part.connections.map { it.id }).isEqualTo(reference.connections)
                    assertThat(part.untilWindow - part.fromWindow).isEqualTo(1)
                    part.nodes.forEach { row ->
                        assertThat(row.windows).hasSize(1)
                        assertThat(coveredNodes.add(row.id to part.fromWindow)).isTrue()
                    }
                    part.connections.forEach { row ->
                        assertThat(row.windows).hasSize(1)
                        assertThat(coveredConnections.add(row.id to part.fromWindow)).isTrue()
                    }
                }
            }
        assertThat(decoded.any { it.nodes.isNotEmpty() && it.connections.isNotEmpty() }).isTrue()
        assertThat(decoded.any { it.nodes.isEmpty() && it.connections.isNotEmpty() }).isTrue()
        assertThat(coveredNodes).hasSize(10)
        assertThat(coveredConnections).hasSize(10)
    }

    @Test
    fun `connection-only windows retain their full range`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/connections/series/v/p0/rep-0"
        val writer = SeriesWriter(workspace, directory, 3.0, 1.0)
        repeat(3) { window ->
            writer.writeWindow(window, emptyList(), listOf(ConnectionWindow("call", ConnectionWindowMetrics(window.toDouble(), 1.0))))
        }
        val index = writer.finish()
        val reference = index.parts.single()
        assertThat(reference.nodes).isEmpty()
        assertThat(reference.connections).containsExactly("call")
        val bytes = GZIPInputStream(workspace.readBytes("$directory/${reference.file}").inputStream()).use { it.readAllBytes() }
        val part = Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8))
        assertThat(
            part.connections
                .single()
                .windows
                .map { it.startMs },
        ).containsExactly(0.0, 1.0, 2.0)
    }

    @Test
    fun `one oversized connection window fails explicitly`(
        @TempDir root: Path,
    ) {
        val writer = SeriesWriter(FileWorkspace(root), ".results/e/r/series/v/p0/rep-0", 1.0, 1.0, maxPartBytes = 100)
        assertThatThrownBy {
            writer.writeWindow(0, emptyList(), listOf(ConnectionWindow("call", ConnectionWindowMetrics(0.0, 1.0))))
        }.hasMessageContaining("connection=call").hasMessageContaining("window=0").hasMessageContaining("100")
    }

    @Test
    fun `mixed gzip bytes are reproducible regardless of input row order`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directories = listOf(".results/e/first/series/v/p0/rep-0", ".results/e/second/series/v/p0/rep-0")
        val indexes =
            directories.mapIndexed { run, directory ->
                val writer = SeriesWriter(workspace, directory, 3.0, 1.0)
                repeat(3) { window ->
                    val nodes = listOf("node-a", "node-ё").map { NodeWindow(it, WindowMetrics(window.toDouble(), 1.0)) }
                    val calls = listOf("call-a", "call-ё").map { ConnectionWindow(it, ConnectionWindowMetrics(window.toDouble(), 1.0)) }
                    writer.writeWindow(window, if (run == 0) nodes else nodes.reversed(), if (run == 0) calls else calls.reversed())
                }
                writer.finish()
            }
        assertThat(indexes[0]).isEqualTo(indexes[1])
        indexes[0].parts.forEach { part ->
            assertThat(workspace.readBytes("${directories[0]}/${part.file}"))
                .isEqualTo(workspace.readBytes("${directories[1]}/${part.file}"))
        }
    }

    @Test
    fun `connection identities are distinct and stable across windows`(
        @TempDir root: Path,
    ) {
        val duplicate = ConnectionWindow("call", ConnectionWindowMetrics(0.0, 1.0))
        val writer = SeriesWriter(FileWorkspace(root), ".results/e/r/series/v/p0/rep-0", 2.0, 1.0)
        assertThatThrownBy { writer.writeWindow(0, emptyList(), listOf(duplicate, duplicate)) }.hasMessageContaining("distinct")
        writer.writeWindow(0, emptyList(), listOf(duplicate))
        assertThatThrownBy {
            writer.writeWindow(1, emptyList(), listOf(duplicate.copy(id = "other", metrics = duplicate.metrics.copy(startMs = 1.0))))
        }.hasMessageContaining("same connections")
    }

    @Test
    fun `consecutive windows fill parts to the byte budget without splitting their nodes`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/packed/series/v/p0/rep-0"
        val rows =
            List(12) { window ->
                listOf("service-a", "service-ё").map { id ->
                    NodeWindow(
                        id,
                        WindowMetrics(
                            window.toDouble(),
                            1.0,
                            slotPools =
                                mapOf(
                                    "handlers" to
                                        resiliencelab.core.experiment.SlotPoolMetrics(
                                            busyIntegralMs = 0.0,
                                            queueIntegralMs = 0.0,
                                            capacityIntegralMs =
                                                (1).toDouble() * (1.0),
                                            queueFullCount = (0).toLong(),
                                        ),
                                ),
                        ),
                    )
                }
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
        val collector = WindowCollector("client", listOf(service()), 20.0, 10.0) { _, rows, _ -> closed += rows }
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
        assertThat(mixed.slotPools.getValue("handlers").queueFullCount).isEqualTo(200)
        assertThat(mixed.latency.count).isEqualTo(2L)
        assertThat(mixed.latency.sumMs).isEqualTo(4.0)
        assertThat(mixed.latency.sketch[0]).isEqualTo(1L)
        assertThat(LatencySketch.fromBins(mixed.latency.sketch).percentile(0.95)!!).isCloseTo(4.0, offset(4.0 / 128))
        val rejected = closed[1].single { it.id == "service" }.metrics
        assertThat(rejected.slotPools.getValue("handlers").queueFullCount).isEqualTo(100)
        assertThat(rejected.latency.count).isZero()
        assertThat(rejected.latency.sketch).containsExactly(0L)
    }

    @Test
    fun `fractional explicit and default windows share the collector completeness rule`(
        @TempDir root: Path,
    ) {
        listOf(Triple(0.07, 0.01, 7), Triple(0.13, 0.13 / 100, 100)).forEachIndexed { run, (end, step, expected) ->
            val writer = SeriesWriter(FileWorkspace(root), ".results/e/r$run/series/v/p0/rep-0", end, step)
            val collector = WindowCollector("client", listOf(service()), end, step, onWindow = writer::writeWindow)
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
        val collector = WindowCollector("client", listOf(service()), 25.0, 10.0) { _, rows, _ -> closed += rows }
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
        assertThat(services.map { it.slotPools.getValue("handlers").busyIntegralMs }).containsExactly(8.0, 3.0, 0.0)
        assertThat(services.map { it.slotPools.getValue("handlers").queueIntegralMs }).containsExactly(12.0, 10.0, 0.0)
        services.forEach {
            assertThat(
                it.slotPools.getValue("handlers").busyIntegralMs / (it.slotPools.getValue("handlers").capacityIntegralMs),
            ).isBetween(0.0, 1.0)
        }
        assertThat(client.sumOf { it.latency.sumMs }).isCloseTo(34.0, offset(1e-12))
    }

    @Test
    fun `parts cover every node connection and window within four MiB with verifiable checksums`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = SeriesWriter(workspace, ".results/e/r/series/v/p0/rep-0", 20.0, 10.0)
        val rows =
            List(20_000) {
                NodeWindow(
                    "service-%05d".format(it),
                    WindowMetrics(
                        0.0,
                        10.0,
                        slotPools =
                            mapOf(
                                "handlers" to
                                    resiliencelab.core.experiment.SlotPoolMetrics(
                                        busyIntegralMs = 0.0,
                                        queueIntegralMs = 0.0,
                                        capacityIntegralMs =
                                            (1).toDouble() * (10.0),
                                        queueFullCount = (0).toLong(),
                                    ),
                            ),
                    ),
                )
            }
        val connections = List(20_000) { ConnectionWindow("call-%05d".format(it), ConnectionWindowMetrics(0.0, 10.0)) }
        writer.writeWindow(0, rows, connections)
        writer.writeWindow(
            1,
            rows.map { it.copy(metrics = it.metrics.copy(startMs = 10.0)) },
            connections.map { it.copy(metrics = it.metrics.copy(startMs = 10.0)) },
        )
        val index = writer.finish()
        assertThat(index.parts.size).isGreaterThan(2)
        val covered = mutableSetOf<Pair<String, Int>>()
        val coveredConnections = mutableSetOf<Pair<String, Int>>()
        for (part in index.parts) {
            val compressed = workspace.readBytes(".results/e/r/series/v/p0/rep-0/${part.file}")
            assertThat(DocumentVersion.of(compressed)).isEqualTo(part.sha256)
            val bytes = GZIPInputStream(compressed.inputStream()).use { it.readAllBytes() }
            assertThat(bytes.size).isEqualTo(part.uncompressedBytes).isLessThanOrEqualTo(SeriesWriter.MAX_PART_BYTES)
            val decoded = Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8))
            assertThat(decoded.nodes.map { it.id }).isEqualTo(part.nodes)
            assertThat(decoded.connections.map { it.id }).isEqualTo(part.connections)
            assertThat(part.untilWindow - part.fromWindow).isEqualTo(1)
            decoded.nodes.forEach { node ->
                assertThat(node.windows).hasSize(part.untilWindow - part.fromWindow)
                for (window in part.fromWindow until part.untilWindow) assertThat(covered.add(node.id to window)).isTrue()
            }
            decoded.connections.forEach { connection ->
                assertThat(connection.windows).hasSize(part.untilWindow - part.fromWindow)
                for (window in part.fromWindow until part.untilWindow) assertThat(coveredConnections.add(connection.id to window)).isTrue()
            }
        }
        assertThat(covered).hasSize(40_000)
        assertThat(coveredConnections).hasSize(40_000)
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

    private fun partBytes(part: SeriesPart) = partJson.encodeToString(SeriesPart.serializer(), part).toByteArray(Charsets.UTF_8)

    private fun service() = ServiceNode("service", 1, 10, Distribution(DistributionShape.FIXED, 1.0), 0.0)
}
