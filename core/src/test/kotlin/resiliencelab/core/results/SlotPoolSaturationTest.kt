package resiliencelab.core.results

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.experiment.SlotPoolMetrics
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Path
import kotlin.test.Test

class SlotPoolSaturationTest {
    @Test
    fun `simultaneous pools at the same graph position use element id order`() {
        val base =
            requireNotNull(
                resiliencelab.core.compiler.PoolerTestModel
                    .compile()
                    .experiment,
            ).variants
                .single()
                .points
                .single()
                .graph
        val source = base.calls.first { it.from == "gateway" }
        val graph = base.copy(calls = base.calls + source.copy(pathSegments = listOf("a-pool"), to = "db"))
        val rows = sequenceOf(row(source.path, 0.0, "pool", duration = 100.0), row("a-pool", 0.0, "pool", duration = 100.0))
        val result = SaturationAnalyzer.detect(0, rows, positions = SlotPoolLabels.positions(graph))
        assertThat(result.degradationPath.map { it.node }).containsExactly("a-pool", source.path)
    }

    @Test
    fun `each slot set has an independent sustained pressure interval`() {
        for (slot in listOf("handlers", "pool", "serverConnections")) {
            val rows = (0 until 4).map { row("element", it * 25.0, slot) }
            val path = SaturationAnalyzer.detect(0, rows.asSequence()).degradationPath

            assertThat(path.map { it.node to it.startMs }).describedAs(slot).containsExactly("element" to 0.0)
            val recorded = Json.encodeToJsonElement(SaturatedNode.serializer(), path.single()).jsonObject
            assertThat(recorded["slotPool"]?.jsonPrimitive?.content).isEqualTo(slot)
        }
    }

    @Test
    fun `wait limit rejections confirm overflow without a queue`() {
        val rows =
            (0..2).map { window ->
                row("call", window * 50.0, "pool", duration = 50.0, busy = 0.0, queue = 0.0, expired = 1)
            }

        assertThat(SaturationAnalyzer.detect(0, rows.asSequence()).degradationPath.map { it.node to it.startMs })
            .containsExactly("call" to 0.0)
    }

    @Test
    fun `client connections only saturate through sustained rejections`() {
        val queued = (0..3).map { row("pooler", it * 25.0, "clientConnections") }
        assertThat(SaturationAnalyzer.detect(0, queued.asSequence()).degradationPath).isEmpty()

        val rejected = (0..4).map { row("pooler", it * 25.0, "clientConnections", queue = 0.0, rejected = 1) }
        assertThat(SaturationAnalyzer.detect(0, rejected.asSequence()).degradationPath.map { it.node to it.startMs })
            .containsExactly("pooler" to 0.0)
    }

    @Test
    fun `pressure in distinct pools cannot be joined into one interval`() {
        val rows =
            (0 until 4).map { window ->
                row("pooler", window * 25.0, if (window < 2) "handlers" else "serverConnections")
            }
        assertThat(SaturationAnalyzer.detect(0, rows.asSequence()).degradationPath).isEmpty()
    }

    @Test
    fun `downstream node precedes the connection pool and its caller on simultaneous onset`() {
        val rows =
            sequenceOf(
                row("caller", 0.0, "handlers", duration = 100.0),
                row("to-db", 0.0, "pool", duration = 100.0),
                row("db", 0.0, "handlers", duration = 100.0),
            )
        val result = SaturationAnalyzer.detect(0, rows, callChain = listOf("caller", "to-db", "db"))
        assertThat(result.degradationPath.map { it.node }).containsExactly("db", "to-db", "caller")
    }

    @Test
    fun `reader includes connection pools across persisted parts`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/r/series/v/p0/rep-0"
        val writer = SeriesWriter(workspace, directory, 200.0, 50.0, maxPartBytes = 1100)
        repeat(4) { window ->
            val start = window * 50.0
            writer.writeWindow(
                window,
                listOf(NodeWindow("client", WindowMetrics(start, 50.0))),
                listOf(
                    ConnectionWindow(
                        "to-db",
                        ConnectionWindowMetrics(
                            start,
                            50.0,
                            slotPools = row("to-db", start, "pool", duration = 50.0).metrics.slotPools,
                        ),
                    ),
                ),
            )
        }
        assertThat(writer.finish().parts.size).isGreaterThan(1)
        val result = SaturationArtifactReader(workspace).read(directory, 0, listOf("to-db"))
        assertThat(result.degradationPath.map { it.node to it.startMs }).containsExactly("to-db" to 0.0)
    }

    private fun row(
        element: String,
        start: Double,
        slot: String,
        duration: Double = 25.0,
        busy: Double = 1.0,
        queue: Double = 1.0,
        rejected: Long = 0,
        expired: Long = 0,
    ) = NodeWindow(
        element,
        WindowMetrics(
            start,
            duration,
            slotPools =
                mapOf(
                    slot to
                        SlotPoolMetrics(
                            busyIntegralMs = busy * duration,
                            capacityIntegralMs = duration,
                            queueIntegralMs = queue * duration,
                            queueFullCount = rejected,
                            waitLimitCount = expired,
                        ),
                ),
        ),
    )
}
