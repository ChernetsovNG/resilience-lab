package resiliencelab.core.execution

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledPoint
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.TestChains
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.LoadSinusoid
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import resiliencelab.core.results.ArtifactWriter
import resiliencelab.core.results.GridPoint
import resiliencelab.core.results.RunManifest
import resiliencelab.core.results.SeriesWriter
import resiliencelab.core.results.Versions
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.Test

class GraphArtifactDeterminismTest {
    @Test
    fun `profiled arrivals preserve every artifact byte across workers and document order`(
        @TempDir root: Path,
    ) {
        val base = graph()
        val profiled =
            base.copy(
                client =
                    base.client.copy(
                        load =
                            LoadProfile(
                                listOf(LoadPoint(0.0, 0.05), LoadPoint(50.0, 0.2)),
                                LoadSinusoid(0.01, 30.0),
                            ),
                    ),
            )
        val reference = run(root.resolve("reference"), profiled, 1, false)
        for (workers in listOf(1, 2, 4, 8)) {
            val actual = run(root.resolve("workers-$workers"), profiled, workers, true)
            assertThat(actual.result).isEqualTo(reference.result)
            assertThat(actual.files.keys).containsExactlyInAnyOrderElementsOf(reference.files.keys)
            reference.files.forEach { (path, bytes) ->
                assertThat(actual.files.getValue(path)).describedAs("$workers/$path").isEqualTo(bytes)
            }
        }
    }

    @Test
    fun `weighted routing and other retry artifacts match across workers and document task order`(
        @TempDir root: Path,
    ) {
        val base = graph()
        val routed =
            base.copy(
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes = listOf(RouteEdge("route-left", "router", "left"), RouteEdge("route-shared", "router", "shared", 3.0)),
                calls = base.calls.map { if (it.path == "entry-left") it.copy(to = "router", retryTarget = RetryTarget.OTHER) else it },
            )
        val expected = run(root.resolve("reference"), routed, 1, false)
        assertThat(
            expected.result.variants.first().points.single().replications.sumOf {
                it.connections.getValue("route-left").sentAttempts + it.connections.getValue("route-shared").sentAttempts
            },
        ).isPositive()
        for (workers in listOf(1, 2, 4, 8)) {
            val actual = run(root.resolve("workers-$workers"), routed, workers, true)
            assertThat(actual.result).isEqualTo(expected.result)
            assertThat(actual.files.keys).containsExactlyInAnyOrderElementsOf(expected.files.keys)
            expected.files.forEach { (path, bytes) ->
                assertThat(actual.files.getValue(path)).describedAs("$workers/$path").isEqualTo(bytes)
            }
        }
    }

    @Test
    fun `branching reconvergent artifacts match across workers and reversed nodes edges and task order`(
        @TempDir root: Path,
    ) {
        val graph = graph()
        val expected = run(root.resolve("reference"), graph, workers = 1, reverse = false)
        assertThat(expected.files).hasSize(26)
        assertThat(
            expected.result.variants
                .first()
                .points
                .single()
                .replications
                .sumOf { it.originalArrivals },
        ).isPositive()
        assertThat(
            expected.result.variants.first().points.single().replications.sumOf {
                it.connections.getValue("left-shared").sentAttempts
            },
        ).isPositive()
        assertThat(
            expected.result.variants.first().points.single().replications.sumOf {
                it.connections.getValue("right-shared").sentAttempts
            },
        ).isPositive()
        for (workers in listOf(1, 2, 4, 8)) {
            for (reverse in listOf(false, true)) {
                val actual = run(root.resolve("$workers-$reverse"), graph, workers, reverse)
                assertThat(actual.result).describedAs("workers=$workers reverse=$reverse").isEqualTo(expected.result)
                assertThat(actual.files.keys).containsExactlyInAnyOrderElementsOf(expected.files.keys)
                expected.files.forEach { (path, bytes) ->
                    assertThat(actual.files.getValue(path)).describedAs("$workers/$reverse/$path").isEqualTo(bytes)
                }
            }
        }
    }

    private fun run(
        root: Path,
        graph: GraphIr,
        workers: Int,
        reverse: Boolean,
    ): Written {
        val workspace = FileWorkspace(Files.createDirectories(root))
        val directory = ".results/graph/run"
        val writer = ArtifactWriter(workspace)
        val variants = listOf("baseline" to "Baseline", "retry" to "Retry")
        val effective =
            if (reverse) {
                graph.copy(
                    services = graph.services.reversed(),
                    calls = graph.calls.reversed(),
                    routers = graph.routers.reversed(),
                    routes = graph.routes.reversed(),
                )
            } else {
                graph
            }
        val compiled =
            variants.map { (id, label) ->
                val variantGraph = if (id == "retry") effective.copy(calls = effective.calls.map { it.copy(attempts = 3) }) else effective
                CompiledVariant(id, label, listOf(CompiledPoint("p0", emptyMap(), variantGraph)))
            }
        val experiment = CompiledExperiment(if (reverse) compiled.reversed() else compiled, graph.run)
        val series = ConcurrentHashMap<Pair<String, Int>, SeriesWriter>()

        fun taskDirectory(
            id: String,
            replication: Int,
        ) = "$directory/series/$id/p0/rep-$replication"
        val result =
            ExperimentExecutor(workers).use { executor ->
                executor.run(
                    experiment,
                    onWindow = { id, _, replication, window, rows, connections ->
                        series
                            .computeIfAbsent(id to replication) {
                                SeriesWriter(
                                    workspace,
                                    taskDirectory(id, replication),
                                    graph.run.warmupMs + graph.run.measurementMs,
                                    graph.run.windowMs,
                                )
                            }.writeWindow(window, rows, connections)
                    },
                    onReplication = { id, _, replication, replicationResult ->
                        series.getValue(id to replication).finish()
                        writer.writeReplication(taskDirectory(id, replication), replicationResult)
                    },
                )
            }
        val summary =
            writer.summarize(
                directory,
                "graph.experiment.json",
                variants,
                graph.run.replications,
                listOf(GridPoint("p0", emptyMap())),
                emptyList(),
                graph.topologicalServices.map { it.path },
            )
        val manifest =
            RunManifest(
                Versions.ARTIFACT_SCHEMA,
                Versions.APPLICATION,
                Versions.KSL,
                PathStreams.ASSIGNMENT_VERSION,
                "graph.experiment.json",
                emptyMap(),
                graph.run.seed,
                graph.run.replications,
                variants.map { it.first },
                emptyMap(),
                true,
                emptyList(),
            )
        writer.write(directory, manifest, summary)
        return Written(
            result.copy(variants = result.variants.sortedBy { it.id }),
            workspace.listFiles(directory).associate { it.removePrefix("$directory/") to workspace.readBytes(it) },
        )
    }

    private fun graph(): GraphIr {
        val base = TestChains.simple()

        fun node(
            id: String,
            steps: List<ServiceStep>? = null,
        ) = ServiceNode(id, 2, 3, TestChains.exponential(2.0), 0.1, scenario = steps)

        fun call(
            id: String,
            from: String,
            to: String,
        ) = CallEdge(
            id,
            from,
            to,
            TestChains.exponential(0.5),
            8.0,
            2,
            TestChains.backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 1.0, 3.0),
        )
        return base.copy(
            client = base.client.copy(load = LoadProfile.constant(0.1), deadlineMs = 40.0),
            services =
                listOf(
                    node(
                        "entry",
                        listOf(
                            ServiceStep.Process(TestChains.exponential(3.0), 0.05),
                            ServiceStep.Call("entry-left"),
                            ServiceStep.Call("entry-right"),
                            ServiceStep.Call("entry-left"),
                        ),
                    ),
                    node("left"),
                    node("right"),
                    node("shared"),
                ),
            calls =
                listOf(
                    call("entry-left", "entry", "left"),
                    call("entry-right", "entry", "right"),
                    call("left-shared", "left", "shared"),
                    call("right-shared", "right", "shared"),
                ),
            run = base.run.copy(replications = 4, warmupMs = 10.0, measurementMs = 120.0, windowMs = 10.0),
        )
    }

    private data class Written(
        val result: ExperimentRun,
        val files: Map<String, ByteArray>,
    )
}
