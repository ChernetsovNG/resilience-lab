package resiliencelab.core.execution

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.lab.Lab
import resiliencelab.core.results.SeriesIndex
import resiliencelab.core.results.SeriesPart
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import kotlin.test.Test

class CostEstimatorArtifactTest {
    @TempDir
    lateinit var temp: Path

    @Test
    fun `graph estimates match persisted rows and stay within half of measured storage`() {
        val examples = Path.of(System.getProperty("resilience-lab.project-root"), "examples")
        for (name in listOf("retry-storm", "checkout")) {
            val source = examples.resolve(name)
            val directory = Files.createDirectories(temp.resolve(name))
            for (file in listOf("$name.model.json", "$name.layout.json", "$name.experiment.json")) {
                Files.copy(source.resolve(file), directory.resolve(file))
            }
        }
        val graph = temp.resolve("graph")
        Files.createDirectories(graph)
        Files.writeString(graph.resolve("m.model.json"), model(3))
        Files.writeString(graph.resolve("e.experiment.json"), experiment)
        val cases =
            listOf(
                "retry-storm/retry-storm.experiment.json",
                "checkout/checkout.experiment.json",
                "graph/e.experiment.json",
            )
        val observations =
            ExperimentExecutor(2).use { executor ->
                Lab(FileWorkspace(temp), executor = executor).use { lab ->
                    cases.map { path ->
                        val estimate = lab.estimate(path, workers = 2)
                        val run = lab.run(path, "cost-check")
                        val root = temp.resolve(run.runDirectory)
                        val files = Files.walk(root).use { paths -> paths.filter { Files.isRegularFile(it) }.toList() }
                        val indexes = files.filter { it.fileName.toString() == "index.json" }
                        var rows = 0L
                        var rawBytes = 0L
                        var parts = 0L
                        indexes.forEach { indexPath ->
                            val index = Json.decodeFromString(SeriesIndex.serializer(), Files.readString(indexPath))
                            index.parts.forEach { reference ->
                                val bytes =
                                    GZIPInputStream(
                                        Files.newInputStream(indexPath.parent.resolve(reference.file)),
                                    ).use { it.readBytes() }
                                val part = Json.decodeFromString(SeriesPart.serializer(), bytes.toString(Charsets.UTF_8))
                                rows +=
                                    part.nodes.sumOf { it.windows.size.toLong() } +
                                    part.connections.sumOf { it.windows.size.toLong() } +
                                    part.classes.sumOf { it.windows.size.toLong() }
                                rawBytes += bytes.size
                                parts++
                            }
                        }
                        val artifactBytes = files.sumOf { Files.size(it) }
                        println(
                            "$path: rows=${estimate.expectedRows}/$rows raw=${estimate.estimatedUncompressedBytes}/$rawBytes artifact=${estimate.estimatedArtifactBytes}/$artifactBytes parts=${estimate.estimatedParts}/$parts",
                        )
                        val compressedBytes = files.filter { it.fileName.toString().startsWith("part-") }.sumOf { Files.size(it) }
                        println(
                            "$path: gzip=$compressedBytes metadata=${artifactBytes - compressedBytes} summary=${Files.size(
                                root.resolve("summary.json"),
                            )} replication=${files.filter { it.fileName.toString() == "replication.json.gz" }.sumOf { Files.size(it) }}",
                        )
                        val seriesChecksums =
                            files
                                .filter { it.fileName.toString().startsWith("part-") }
                                .sorted()
                                .joinToString { DocumentVersion.of(Files.readAllBytes(it)) }
                        println(
                            "$path: summarySha=${DocumentVersion.of(
                                Files.readAllBytes(root.resolve("summary.json")),
                            )} seriesSha=${DocumentVersion.of(seriesChecksums.toByteArray())}",
                        )
                        Observation(path, estimate, rows, rawBytes, artifactBytes)
                    }
                }
            }
        observations.forEach { (path, estimate, rows, rawBytes, artifactBytes) ->
            assertThat(estimate.expectedRows).describedAs("%s persisted rows", path).isEqualTo(rows)
            assertThat(
                estimate.estimatedUncompressedBytes.toDouble() / rawBytes,
            ).describedAs("%s raw series ratio", path).isBetween(0.5, 1.5)
            assertThat(
                estimate.estimatedArtifactBytes.toDouble() / artifactBytes,
            ).describedAs("%s artifact ratio", path).isBetween(0.5, 1.5)
        }
    }

    private data class Observation(
        val path: String,
        val estimate: ExperimentEstimate,
        val rows: Long,
        val rawBytes: Long,
        val artifactBytes: Long,
    )

    companion object {
        internal fun model(replicas: Int): String =
            """{"schemaVersion":7,"blocks":{
              "client":{"type":"client","params":{"load":{"points":[{"time":"0ms","rate":"100/s"}]},"deadline":"1s"}},
              "gateway":{"type":"service","params":{"handlers":20,"processing":{"kind":"fixed","mean":"1ms"}}},
              "router":{"type":"router","params":{"policy":"roundRobin"}},
              "worker":{"type":"service","params":{"replicas":$replicas,"handlers":10,"processing":{"kind":"fixed","mean":"2ms"}}},
              "pooler":{"type":"pooler","params":{"maxClientConnections":20,"poolSize":2,"waitTimeout":"50ms","processing":{"kind":"fixed","mean":"1ms"}}},
              "db":{"type":"database","params":{"maxConnections":3,"processing":{"kind":"fixed","mean":"9ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"gateway"},
              {"id":"to-router","type":"call","from":"gateway","to":"router","params":{"timeout":"200ms"}},
              {"id":"to-worker","type":"route","from":"router","to":"worker"},
              {"id":"to-pooler","type":"call","from":"worker","to":"pooler","params":{"timeout":"100ms","pool":{"size":2,"acquireTimeout":"50ms"}}},
              {"id":"to-db","type":"call","from":"pooler","to":"db","params":{"timeout":"100ms"}}
            ]}"""

        internal val experiment =
            """{"schemaVersion":4,"modelRef":"m.model.json","execution":{"replications":2,"warmup":"200ms","measurement":"1s","window":"100ms","seed":42},"variants":[{"id":"baseline"}]}"""
    }
}
