package resiliencelab.core.results

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
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

@OptIn(ExperimentalSerializationApi::class)
class WebSeriesGoldenTest {
    private val root = Path.of(System.getProperty("resilience-lab.project-root"))
    private val golden = root.resolve("web/src/results/series/fixtures/retry-storm-baseline-rep-0.json")
    private val seriesJson =
        Json {
            encodeDefaults = true
            explicitNulls = false
        }

    @Test
    fun `catalog calculations match the shared web interpreter fixture`() {
        WebOutputGolden.verify(root)
    }

    @Test
    fun `committed web retry storm fixture round trips and matches core quantile bits`(
        @TempDir temporary: Path,
    ) {
        if (System.getenv("UPDATE_SERIES_GOLDEN") == "1") regenerateGolden(temporary)

        val expected = Json.decodeFromString(WebSeriesGolden.serializer(), Files.readString(golden))
        val part = seriesJson.decodeFromJsonElement(SeriesPart.serializer(), expected.part)
        assertThat(seriesJson.encodeToJsonElement(SeriesPart.serializer(), part))
            .describedAs("committed part must round-trip through current SeriesPart without changes")
            .isEqualTo(expected.part)
        assertThat(quantileBits(part))
            .describedAs("quantile bits must match the committed core reference")
            .isEqualTo(expected.quantiles)
    }

    private fun regenerateGolden(temporary: Path) {
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
                quantiles = quantileBits(part),
            )
        Files.createDirectories(golden.parent)
        Files.writeString(golden, DocumentCodec.encode(WebSeriesGolden.serializer(), expected))
    }

    private fun quantileBits(part: SeriesPart): List<WebQuantileBits> =
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
        }

    private fun copyExamples(temporary: Path) {
        val source = root.resolve("examples/retry-storm")
        val directory = Files.createDirectories(temporary.resolve("retry-storm"))
        for (file in listOf("retry-storm.model.json", "retry-storm.layout.json", "retry-storm.experiment.json")) {
            Files.copy(source.resolve(file), directory.resolve(file))
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
    val p50: String? = null,
    val p95: String? = null,
    val p99: String? = null,
)

private fun Double?.bits(): String? =
    this
        ?.toRawBits()
        ?.toULong()
        ?.toString(16)
        ?.padStart(16, '0')
