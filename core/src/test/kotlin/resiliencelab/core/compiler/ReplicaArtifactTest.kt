package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ModelFile
import resiliencelab.core.engine.ksl.PathStreamSource
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.ReliabilityModel
import resiliencelab.core.engine.ksl.StreamPlan
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceStep
import resiliencelab.core.lab.Lab
import resiliencelab.core.results.SeriesWriter
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class ReplicaArtifactTest {
    private val documents = ReplicaGroupsTest()

    @Test
    fun `group and explicit graph with identical instance paths produce identical artifact bytes`(
        @TempDir root: Path,
    ) {
        val grouped = documents.graph(documents.model(3))
        val plain = documents.graph(documents.model(1))
        val worker = plain.services.single { it.path == "worker" }
        val outgoing = plain.calls.single { it.from == "worker" }
        val explicit =
            plain.copy(
                services =
                    listOf(plain.services.first()) +
                        (1..3).map { number ->
                            worker.copy(
                                pathSegments = listOf("worker", "#$number"),
                                scenario =
                                    worker.scenario!!.map { step ->
                                        if (step is ServiceStep.Call) step.copy(edge = "worker-to-tail#$number") else step
                                    },
                            )
                        } + plain.services.last(),
                calls =
                    listOf(plain.calls.first().copy(to = "worker#lb")) +
                        (1..3).map { number ->
                            outgoing.copy(pathSegments = listOf("worker-to-tail", "#$number"), from = "worker#$number")
                        },
                routers = listOf(RouterNode(listOf("worker", "#lb"), RoutingPolicy.RANDOM, worker.origin)),
                routes =
                    (1..3).map { number ->
                        RouteEdge(listOf("worker", "#lb", "#$number"), "worker#lb", "worker#$number", origin = worker.origin)
                    },
            )

        fun artifact(
            graph: GraphIr,
            name: String,
        ): Map<String, ByteArray> {
            val directory = Files.createDirectories(root.resolve(name))
            FileWorkspace(directory).use { workspace ->
                val writer =
                    SeriesWriter(
                        workspace,
                        "series",
                        graph.run.warmupMs + graph.run.measurementMs,
                        graph.run.windowMs,
                        groups =
                            resiliencelab.core.experiment.ReplicaGroups
                                .membership(graph),
                    )
                val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
                val result =
                    ReliabilityModel(
                        ksl.simulation.Model("ReplicaArtifact", autoCSVReports = false),
                        graph,
                        streams,
                        onWindow = { index, nodes, calls -> writer.writeWindow(index, nodes, calls) },
                    ).runReplication()
                writer.finish()
                workspace.create("summary.json", DocumentCodec.encode(ReplicationResult.serializer(), result))
            }
            return files(directory)
        }
        assertBytes(artifact(grouped, "group"), artifact(explicit, "explicit"))
    }

    @Test
    fun `replica artifacts including manifests repeat across workers and document permutations`(
        @TempDir root: Path,
    ) {
        val source = documents.model(3, tailReplicas = 2, overrides = """, "replicaOverrides":{"2":{"handlers":4}}""")
        val experiment = documents.experiment("""[{"target":"worker#2","from":"100ms","to":"500ms","kind":"slowdown","multiplier":3}]""")

        fun run(
            source: ModelFile,
            name: String,
            workers: Int,
        ): Map<String, ByteArray> {
            val directory = Files.createDirectories(root.resolve(name))
            Files.writeString(directory.resolve("m.model.json"), DocumentCodec.encodeModel(source))
            Files.writeString(directory.resolve("e.experiment.json"), DocumentCodec.encodeExperiment(experiment))
            val outcome =
                ExperimentExecutor(workers).use { executor ->
                    Lab(FileWorkspace(directory), executor = executor).use { it.run("e.experiment.json", "run") }
                }
            return files(directory.resolve(outcome.runDirectory))
        }
        val expected = run(source, "reference", 1)
        val shuffled =
            source.copy(
                blocks =
                    source.blocks.entries
                        .reversed()
                        .associate { it.toPair() },
                connections = source.connections.reversed(),
            )
        for (workers in listOf(2, 4, 8)) assertBytes(expected, run(shuffled, "workers-$workers", workers))
    }

    private fun files(root: Path): Map<String, ByteArray> =
        Files.walk(root).use { paths ->
            paths.filter(Files::isRegularFile).toList().associate { root.relativize(it).toString() to Files.readAllBytes(it) }
        }

    private fun assertBytes(
        expected: Map<String, ByteArray>,
        actual: Map<String, ByteArray>,
    ) {
        assertThat(actual.keys).containsExactlyInAnyOrderElementsOf(expected.keys)
        expected.forEach { (path, bytes) -> assertThat(actual.getValue(path)).describedAs(path).isEqualTo(bytes) }
    }
}
