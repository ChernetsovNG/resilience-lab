package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import kotlin.test.Test

class WebSeriesGoldenTest {
    private val root = Path.of(System.getProperty("resilience-lab.project-root"))
    private val golden = root.resolve("web/src/results/series/fixtures/retry-storm-baseline-rep-0.json")

    @Test
    fun `web retry storm fixture matches core series and quantile bits`(
        @TempDir temporary: Path,
    ) {
        copyExamples(temporary)
        val outcome = Lab(FileWorkspace(temporary)).use { it.run("retry-storm/retry-storm.experiment.json", "golden") }
        val task = temporary.resolve("${outcome.runDirectory}/series/baseline/p0/rep-0")
        val index = Json.decodeFromString(SeriesIndex.serializer(), Files.readString(task.resolve("index.json")))
        assertThat(index.parts).hasSize(1)
        val reference = index.parts.single()
        val text =
            GZIPInputStream(Files.newInputStream(task.resolve(reference.file))).use {
                String(it.readBytes(), Charsets.UTF_8)
            }
        val part = Json.decodeFromString(SeriesPart.serializer(), text)
        val expected =
            WebSeriesGolden(
                variant = "baseline",
                replication = 0,
                part = Json.parseToJsonElement(text),
                quantiles =
                    part.nodes.flatMap { node ->
                        node.windows.mapIndexed { window, metrics ->
                            val sketch = LatencySketch.fromBins(metrics.latency.sketch)
                            WebQuantileBits(
                                node = node.id,
                                window = window,
                                p50 = sketch.percentile(0.50).bits(),
                                p95 = sketch.percentile(0.95).bits(),
                                p99 = sketch.percentile(0.99).bits(),
                            )
                        }
                    },
            )
        val encoded = DocumentCodec.encode(WebSeriesGolden.serializer(), expected)
        if (System.getenv("UPDATE_SERIES_GOLDEN") == "1") {
            Files.createDirectories(golden.parent)
            Files.writeString(golden, encoded)
        }
        assertThat(golden).exists()
        assertThat(Files.readString(golden))
            .describedAs("web series golden is stale; regenerate with UPDATE_SERIES_GOLDEN=1")
            .isEqualTo(encoded)
        assertThat(Json.parseToJsonElement(Files.readString(golden)).jsonObject.getValue("part"))
            .describedAs("golden part preserves every field written by the series API")
            .isEqualTo(Json.parseToJsonElement(text))
    }

    private fun copyExamples(temporary: Path) {
        val source = root.resolve("examples/retry-storm")
        Files.walk(source).use { paths ->
            paths.filter(Files::isRegularFile).forEach { file ->
                val destination = temporary.resolve("retry-storm").resolve(source.relativize(file))
                Files.createDirectories(destination.parent)
                Files.copy(file, destination)
            }
        }
    }
}

@Serializable
private data class WebSeriesGolden(
    val variant: String,
    val replication: Int,
    val part: kotlinx.serialization.json.JsonElement,
    val quantiles: List<WebQuantileBits>,
)

@Serializable
private data class WebQuantileBits(
    val node: String,
    val window: Int,
    val p50: String?,
    val p95: String?,
    val p99: String?,
)

private fun Double?.bits(): String? =
    this
        ?.toRawBits()
        ?.toULong()
        ?.toString(16)
        ?.padStart(16, '0')
