package resiliencelab.core.results

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import resiliencelab.core.workspace.Workspace
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.test.Test

class ArtifactPipelineTest {
    @TempDir
    lateinit var temp: Path
    private val experiment = "retry-storm/retry-storm.experiment.json"

    @Test
    fun `caller cancellation during a worker write waits for parts and publishes an incomplete manifest`() {
        val root = example("interrupted")
        val backing = FileWorkspace(root)
        val writing = CountDownLatch(1)
        val release = CountDownLatch(1)
        val first = AtomicBoolean(true)
        val failure = AtomicReference<Throwable?>()
        val interrupted = AtomicBoolean()
        val workspace =
            object : Workspace by backing {
                override fun createBytes(
                    path: String,
                    bytes: ByteArray,
                ): String {
                    if (path.endsWith(".json.gz") && first.compareAndSet(true, false)) {
                        writing.countDown()
                        check(release.await(5, TimeUnit.SECONDS))
                    }
                    return backing.createBytes(path, bytes)
                }
            }
        val caller =
            thread(isDaemon = true) {
                ExperimentExecutor(1).use { executor ->
                    try {
                        Lab(workspace, executor = executor).run(experiment, "r")
                    } catch (exception: Throwable) {
                        failure.set(exception)
                        interrupted.set(Thread.currentThread().isInterrupted)
                    }
                }
            }
        try {
            assertThat(writing.await(5, TimeUnit.SECONDS)).isTrue()
            caller.interrupt()
            release.countDown()
            caller.join(5000)
            assertThat(caller.isAlive).isFalse()
            assertThat(failure.get()).isInstanceOf(CancellationException::class.java)
            assertThat(interrupted.get()).isTrue()
            val manifest = Json.decodeFromString(RunManifest.serializer(), backing.read(".results/retry-storm/r/manifest.json").text)
            assertThat(manifest.complete).isFalse()
            assertThat(manifest.parts).isNotEmpty()
            assertThat(backing.exists(".results/retry-storm/r/summary.json")).isFalse()
            assertThat(manifest.parts.keys).hasSize(backing.listFiles(".results/retry-storm/r").size - 1)
            manifest.parts.forEach { (path, checksum) ->
                assertThat(DocumentVersion.of(backing.readBytes(".results/retry-storm/r/$path"))).isEqualTo(checksum)
            }
        } finally {
            release.countDown()
            caller.interrupt()
            caller.join(5000)
        }
    }

    @Test
    fun `artifact is byte identical across workers and document order and summary rebuilds from replication files`() {
        val sequential = example("one")
        val parallel = example("three")
        val reordered = example("reordered")
        val modelPath = reordered.resolve("retry-storm/retry-storm.model.json")
        val model = (DocumentCodec.decodeModel(Files.readString(modelPath), modelPath.toString()) as DecodeResult.Ok).value
        Files.writeString(
            modelPath,
            DocumentCodec.encodeModel(
                model.copy(
                    blocks =
                        model.blocks
                            .toList()
                            .reversed()
                            .toMap(),
                    connections = model.connections.reversed(),
                ),
            ),
        )

        fun run(
            root: Path,
            workers: Int,
        ) = ExperimentExecutor(workers).use { executor ->
            Lab(FileWorkspace(root), executor = executor).use { it.run(experiment, "r") }
        }
        val first = run(sequential, 1)
        run(parallel, 3)
        run(reordered, 3)
        val workspace = FileWorkspace(sequential)
        val files = workspace.listFiles(first.runDirectory)
        assertThat(files).anyMatch { it.endsWith("/replication.json") }.anyMatch { it.endsWith("/index.json") }
        val indexes = files.filter { it.endsWith("/index.json") }
        assertThat(indexes).hasSize(20)
        indexes.forEach { path ->
            val index = Json.decodeFromString(SeriesIndex.serializer(), workspace.read(path).text)
            assertThat(index.parts).hasSize(1)
            assertThat(index.parts.single().fromWindow).isZero()
            assertThat(index.parts.single().untilWindow).isEqualTo(100)
            assertThat(index.schemaVersion).isEqualTo(3)
            assertThat(index.parts.single().connections).containsExactly("gateway-to-middle", "middle-to-dependency")
        }
        for (path in files) {
            val bytes = workspace.readBytes(path)
            assertThat(Files.readAllBytes(parallel.resolve(path))).describedAs(path).isEqualTo(bytes)
            assertThat(Files.readAllBytes(reordered.resolve(path))).describedAs(path).isEqualTo(bytes)
        }
        val rebuilt =
            ArtifactWriter(workspace).summarize(
                first.runDirectory,
                experiment,
                first.summary.variants.map { it.id to it.label },
                first.manifest.replications,
                requireNotNull(first.manifest.series).points,
                first.manifest.grid,
                listOf("gateway", "middle", "dependency"),
            )
        assertThat(DocumentCodec.encode(RunSummary.serializer(), rebuilt))
            .isEqualTo(workspace.read("${first.runDirectory}/summary.json").text)
        assertThat(workspace.read("${first.runDirectory}/summary.json").text)
            .contains(
                "\"minimumDurationMs\": 100.0",
                "\"handlerUtilizationThreshold\": 0.95",
                "\"meanQueueLengthThreshold\": 0.5",
                "\"queueRejectionsThreshold\": 0",
            )
        assertThat(first.manifest.complete).isTrue()
        assertThat(first.manifest.schemaVersion).isEqualTo(8)
        first.summary.variants.forEach { variant ->
            variant.points.forEach { point ->
                assertThat(point.aggregate.connections.keys).containsExactly("gateway-to-middle", "middle-to-dependency")
                listOf(Triple("gateway-to-middle", "gateway", "middle"), Triple("middle-to-dependency", "middle", "dependency"))
                    .forEach { (id, caller, child) ->
                        val connection = point.aggregate.connections.getValue(id)
                        val totals = connection.totals
                        assertThat(totals.sentAttempts).isEqualTo(totals.succeeded + totals.failed + totals.timeouts)
                        assertThat(totals.sentAttempts).isEqualTo(
                            point.aggregate.services
                                .getValue(child)
                                .totals.offeredAttempts,
                        )
                        assertThat(totals.timeouts).isEqualTo(
                            point.aggregate.services
                                .getValue(caller)
                                .totals.timeouts,
                        )
                        assertThat(totals.retries).isEqualTo(
                            point.aggregate.services
                                .getValue(caller)
                                .totals.retries,
                        )
                        assertThat(totals.orphaned).isLessThanOrEqualTo(totals.timeouts)
                        assertThat(connection.pooledLatency?.statistics?.count ?: 0L).isEqualTo(totals.succeeded + totals.failed)
                    }
                assertThat(point.saturation.rule).isEqualTo(SaturationRule())
                assertThat(point.saturation.replications).hasSize(10)
                assertThat(
                    point.saturation.withoutSaturation +
                        point.saturation.replications.count { it.degradationPath.isNotEmpty() },
                ).isEqualTo(10)
            }
        }
        assertThat(first.manifest.parts.keys).hasSize(files.size - 1)
        first.manifest.parts.forEach { (path, checksum) ->
            assertThat(DocumentVersion.of(workspace.readBytes("${first.runDirectory}/$path"))).isEqualTo(checksum)
        }
        val replication =
            Json.decodeFromString(
                ReplicationArtifact.serializer(),
                workspace
                    .read(
                        "${first.runDirectory}/series/baseline/p0/rep-0/replication.json",
                    ).text,
            )
        assertThat(replication.result.allLatency.count).isEqualTo(replication.result.originalArrivals.toLong())
        assertThat(workspace.read("${first.runDirectory}/series/baseline/p0/rep-0/replication.json").text)
            .doesNotContain("arrivalTimesMs", "allLatenciesMs")
    }

    @Test
    fun `failed task leaves checksummed parts and an incomplete final manifest without summary`() {
        val root = example("partial")
        val backing = FileWorkspace(root)
        val failing =
            object : Workspace by backing {
                override fun createBytes(
                    path: String,
                    bytes: ByteArray,
                ): String {
                    if (path.contains("/rep-1/part-0.json.gz")) throw IOException("disk unavailable")
                    return backing.createBytes(path, bytes)
                }
            }
        ExperimentExecutor(1).use { executor ->
            assertThatThrownBy { Lab(failing, executor = executor).run(experiment, "r") }.hasMessageContaining("disk unavailable")
        }
        val manifest = Json.decodeFromString(RunManifest.serializer(), backing.read(".results/retry-storm/r/manifest.json").text)
        assertThat(manifest.complete).isFalse()
        assertThat(manifest.parts).isNotEmpty()
        assertThat(backing.exists(".results/retry-storm/r/summary.json")).isFalse()
        assertThat(manifest.parts.keys).hasSize(backing.listFiles(".results/retry-storm/r").size - 1)
        assertThat(RunCatalog(backing).list().single().complete).isFalse()
    }

    private fun example(name: String): Path {
        val root = Files.createDirectory(temp.resolve(name))
        val source = Path.of(System.getProperty("resilience-lab.project-root"), "examples", "retry-storm")
        Files.walk(source).use { paths ->
            paths.filter { Files.isRegularFile(it) }.forEach { file ->
                val destination = root.resolve("retry-storm").resolve(source.relativize(file))
                Files.createDirectories(destination.parent)
                Files.copy(file, destination)
            }
        }
        return root
    }
}
