package resiliencelab.core.results

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import kotlin.test.Test

class AggregateArtifactTest {
    @TempDir
    lateinit var temp: Path

    private val json = Json { explicitNulls = false }

    @Test
    fun `aggregate bytes are identical at 1 2 4 and 8 threads and after resume`() {
        var expected: RunManifest? = null
        for (threads in listOf(1, 2, 4, 8)) {
            val workspace = example(threads)
            ExperimentExecutor(threads).use { executor ->
                Lab(workspace, executor = executor).use { lab ->
                    val outcome = lab.run("checkout-replicas/checkout-replicas.experiment.json", "aggregate")
                    if (expected == null) expected = outcome.manifest else assertThat(outcome.manifest).isEqualTo(expected)
                    val catalog = RunCatalog(workspace)
                    for (variant in listOf("baseline", "bigger-pool")) {
                        for (point in listOf("p0", "p1")) {
                            val index = requireNotNull(catalog.aggregateSeriesIndex("aggregate", variant, point))
                            assertThat(index.replications).isEqualTo(3)
                            assertThat(index.endMs).isEqualTo(1250.0)
                            assertThat(index.parts.filter { it.kind == SeriesPartKind.GROUP }.flatMap { it.nodes })
                                .contains("mobile-app", "order-service", "orders-db", "pgbouncer")
                                .doesNotContain("order-service#1", "order-service#2", "order-service#3")
                            assertThat(index.parts.filter { it.kind == SeriesPartKind.INSTANCE }.flatMap { it.nodes })
                                .contains("order-service#1", "order-service#2", "order-service#3")
                            for (reference in index.parts) {
                                val number =
                                    reference.file
                                        .removePrefix("part-")
                                        .removeSuffix(".json.gz")
                                        .toInt()
                                val stored = requireNotNull(catalog.aggregateSeriesPart("aggregate", variant, point, number))
                                assertThat(DocumentVersion.of(stored.bytes)).isEqualTo(reference.sha256)
                                val text = GZIPInputStream(stored.bytes.inputStream()).bufferedReader().use { it.readText() }
                                val part = json.decodeFromString(AggregateSeriesPart.serializer(), text)
                                assertThat(part.replications).isEqualTo(3)
                                val client = part.nodes.find { it.id == "mobile-app" }
                                if (client != null) {
                                    assertThat(client.windows.first().outputs).containsKeys("originalArrivalsPerSecond", "p99LatencyMs")
                                    assertThat(
                                        client.windows
                                            .first()
                                            .outputs
                                            .getValue("originalArrivalsPerSecond")
                                            .count,
                                    ).isNull()
                                }
                                val pooler = part.nodes.find { it.id == "pgbouncer" }
                                if (pooler !=
                                    null
                                ) {
                                    assertThat(pooler.windows.first().outputs).containsKeys("clientUtilization", "serverUtilization")
                                }
                            }
                        }
                    }
                    assertThat(catalog.aggregateSeriesIndex("aggregate", "unknown", "p0")).isNull()
                    if (threads == 1) {
                        workspace.write(
                            "${outcome.runDirectory}/manifest.json",
                            DocumentCodec.encode(RunManifest.serializer(), outcome.manifest.copy(complete = false)),
                        )
                        assertThat(lab.resume(outcome.runDirectory).manifest).isEqualTo(outcome.manifest)
                    }
                }
            }
        }
    }

    @Test
    fun `persisted default counters contribute zero and the final window uses its actual duration`() {
        val workspace = example(99)
        val modelPath = "checkout-replicas/checkout-replicas.model.json"
        val experimentPath = "checkout-replicas/checkout-replicas.experiment.json"
        val model = (DocumentCodec.decodeModel(workspace.read(modelPath).text, modelPath) as DecodeResult.Ok).value
        val experiment = (DocumentCodec.decodeExperiment(workspace.read(experimentPath).text, experimentPath) as DecodeResult.Ok).value
        val compiled = requireNotNull(ModelCompiler().compile(model, modelPath, experiment, experimentPath).experiment)
        for (variant in compiled.variants) {
            for (point in variant.points) {
                for (replication in 0 until 3) {
                    val directory = "synthetic/series/${variant.id}/${point.id}/rep-$replication"
                    val writer = SeriesWriter(workspace, directory, 1250.0, 100.0)
                    for (window in 0 until 13) {
                        writer.writeWindow(
                            window,
                            listOf(
                                NodeWindow(
                                    "mobile-app",
                                    WindowMetrics(
                                        window * 100.0,
                                        if (window ==
                                            12
                                        ) {
                                            50.0
                                        } else {
                                            100.0
                                        },
                                        originalArrivals = replication * 2,
                                    ),
                                ),
                            ),
                        )
                    }
                    writer.finish()
                }
            }
        }
        AggregateSeriesWriter(workspace).write("synthetic", compiled)
        val directory = "synthetic/series/baseline/p0/aggregate"
        val index = json.decodeFromString(AggregateSeriesIndex.serializer(), workspace.read("$directory/index.json").text)
        val text =
            GZIPInputStream(workspace.readBytes("$directory/${index.parts.single().file}").inputStream()).bufferedReader().use {
                it.readText()
            }
        val windows =
            json
                .decodeFromString(AggregateSeriesPart.serializer(), text)
                .nodes
                .single()
                .windows
        assertThat(windows.first().outputs.getValue("originalArrivalsPerSecond")).isEqualTo(AggregateOutput(mean = 20.0, stdDev = 20.0))
        assertThat(windows.last().outputs.getValue("originalArrivalsPerSecond")).isEqualTo(AggregateOutput(mean = 40.0, stdDev = 40.0))
        assertThat(windows.first().outputs.getValue("successesPerSecond")).isEqualTo(AggregateOutput(mean = 0.0, stdDev = 0.0))
        assertThat(windows.first().outputs.getValue("p99LatencyMs")).isEqualTo(AggregateOutput(count = 0))
    }

    @Test
    fun `aggregate parts obey byte budgets with split rows and shortened final windows`() {
        val workspace = FileWorkspace(Files.createDirectories(temp.resolve("split")))
        val writer = SeriesWriter(workspace, "series", 250.0, 100.0, maxPartBytes = 1200, aggregateReplications = 3)
        for (window in 0 until 3) {
            writer.writeAggregateWindow(
                window,
                (0 until 30).map { row ->
                    AggregateRowWindow(
                        "node-$row",
                        AggregateWindowMetrics(
                            mapOf(
                                "rate" to AggregateOutput(mean = (window + row).toDouble(), stdDev = 0.25),
                            ),
                        ),
                    )
                },
            )
        }
        val index = writer.finish()
        assertThat(index.parts.size).isGreaterThan(3)
        val coverage = mutableListOf<Pair<String, Int>>()
        index.parts.forEach { reference ->
            val bytes = workspace.readBytes("series/${reference.file}")
            val decoded = GZIPInputStream(bytes.inputStream()).use { it.readBytes() }
            assertThat(decoded.size).isEqualTo(reference.uncompressedBytes).isLessThanOrEqualTo(1200)
            val part = json.decodeFromString(AggregateSeriesPart.serializer(), decoded.toString(Charsets.UTF_8))
            part.nodes.forEach { row ->
                assertThat(row.windows.size).isEqualTo(part.untilWindow - part.fromWindow)
                row.windows.indices.forEach { coverage += row.id to part.fromWindow + it }
            }
        }
        assertThat(coverage).containsExactlyInAnyOrderElementsOf((0 until 30).flatMap { row -> (0 until 3).map { "node-$row" to it } })
    }

    private fun example(threads: Int): FileWorkspace {
        val root = Files.createDirectories(temp.resolve("threads-$threads"))
        val source = Path.of(System.getProperty("resilience-lab.project-root"), "examples/checkout-replicas")
        val directory = Files.createDirectories(root.resolve("checkout-replicas"))
        Files.list(source).use { files ->
            files.filter { Files.isRegularFile(it) }.forEach { Files.copy(it, directory.resolve(it.fileName)) }
        }
        val file = directory.resolve("checkout-replicas.experiment.json")
        val original = json.parseToJsonElement(Files.readString(file)) as JsonObject
        val execution =
            JsonObject(
                mapOf(
                    "seed" to JsonPrimitive(20261031),
                    "warmup" to JsonPrimitive("0s"),
                    "measurement" to JsonPrimitive("1250ms"),
                    "window" to JsonPrimitive("100ms"),
                    "replications" to JsonPrimitive(3),
                ),
            )
        Files.writeString(
            file,
            JsonObject(
                original +
                    mapOf(
                        "execution" to execution,
                        "faults" to JsonArray(emptyList()),
                        "variants" to
                            JsonArray((original.getValue("variants") as JsonArray).filterIndexed { index, _ -> index == 0 || index == 3 }),
                        "grid" to json.parseToJsonElement("""[{"path":"api-gateway.handlers","values":[100,200]}]"""),
                    ),
            ).toString(),
        )
        return FileWorkspace(root)
    }
}
