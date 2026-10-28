package resiliencelab.core.results

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Path
import kotlin.test.Test

class SaturationArtifactReaderTest {
    @Test
    fun `split parts and node groups preserve every nodes chronological path`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/r/series/v/p0/rep-0"
        val hot = WindowMetrics(0.0, 25.0, busyHandlerTimeMs = 23.75, handlers = 1, queueLengthIntegralMs = 25.0)
        val json = Json { encodeDefaults = true }
        val budget =
            (0 until 4).maxOf { window ->
                val part =
                    SeriesPart(
                        fromWindow = window,
                        untilWindow = window + 1,
                        nodes = listOf(NodeSeries("a", listOf(hot.copy(startMs = window * 25.0)))),
                    )
                json.encodeToString(SeriesPart.serializer(), part).toByteArray(Charsets.UTF_8).size
            }
        val writer = SeriesWriter(workspace, directory, 100.0, 25.0, maxPartBytes = budget)
        repeat(4) { window ->
            val metrics = hot.copy(startMs = window * 25.0)
            writer.writeWindow(
                window,
                listOf(NodeWindow("b", metrics), NodeWindow("a", metrics)),
            )
        }
        val index = writer.finish()
        assertThat(index.parts).hasSize(8)

        val result = SaturationArtifactReader(workspace).read(directory, 0, listOf("a", "b"))

        assertThat(result)
            .isEqualTo(
                ReplicationSaturation(
                    0,
                    listOf(SaturatedNode("b", 0.0), SaturatedNode("a", 0.0)),
                ),
            )
    }
}
