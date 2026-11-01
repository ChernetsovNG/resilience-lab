package resiliencelab.core.results

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.GZIPInputStream
import kotlin.concurrent.thread
import kotlin.test.Test

class ArtifactPipelineTest {
    @TempDir
    lateinit var temp: Path
    private val experiment = "retry-storm/retry-storm.experiment.json"

    @Test
    fun `run and resume summarize saved saturation without opening series parts`() {
        val root = example("saved-saturation")
        val backing = FileWorkspace(root)
        val summarizing = AtomicBoolean()
        val seriesReads = AtomicInteger()
        val workspace =
            object : Workspace by backing {
                override fun readBytes(path: String): ByteArray {
                    if (summarizing.get() && path.substringAfterLast('/').startsWith("part-")) {
                        seriesReads.incrementAndGet()
                        error("Summary must not read series parts")
                    }
                    return backing.readBytes(path)
                }

                override fun create(
                    path: String,
                    text: String,
                ): String {
                    if (path.endsWith("/summary.json")) summarizing.set(false)
                    return backing.create(path, text)
                }
            }
        ExperimentExecutor(2).use { executor ->
            Lab(workspace, executor = executor).use { lab ->
                val original = lab.run(experiment, "r", onProgress = { done, total -> summarizing.set(done == total) })
                assertThat(original.manifest.schemaVersion).isEqualTo(18)
                val task = "${original.runDirectory}/series/baseline/p0/rep-0/replication.json.gz"
                val stored =
                    Json
                        .parseToJsonElement(
                            GZIPInputStream(backing.readBytes(task).inputStream()).bufferedReader().use { it.readText() },
                        ).jsonObject
                assertThat(stored["schemaVersion"]?.jsonPrimitive?.content).isEqualTo("7")
                assertThat(stored["saturation"]).isNotNull()
                backing.delete(task)
                backing.write(
                    "${original.runDirectory}/manifest.json",
                    DocumentCodec.encode(RunManifest.serializer(), original.manifest.copy(complete = false)),
                )
                val progress = mutableListOf<Pair<Int, Int>>()
                val resumed =
                    lab.resume(original.runDirectory, onProgress = { done, total ->
                        progress += done to total
                        summarizing.set(done == total)
                    })
                assertThat(progress).containsExactly(19 to 20, 20 to 20)
                assertThat(resumed.summary).isEqualTo(original.summary)
                assertThat(resumed.manifest).isEqualTo(original.manifest)
                assertThat(seriesReads.get()).isZero()
            }
        }
    }

    @Test
    fun `storage cancellation is not retried while the executor remains open`() {
        for (pooled in listOf(false, true)) {
            val backing = FileWorkspace(example("storage-cancel-$pooled"))
            val reads = AtomicInteger()
            val workspace =
                object : Workspace by backing {
                    override fun readBytes(path: String): ByteArray {
                        if (reads.incrementAndGet() == 1) throw CancellationException("storage cancelled")
                        return backing.readBytes(path)
                    }
                }
            ExperimentExecutor(2).use { executor ->
                assertThatThrownBy {
                    ArtifactWriter(workspace, if (pooled) executor else null).summarize(
                        ".results/e/r",
                        "e",
                        listOf("baseline" to "Baseline"),
                        1,
                        listOf(GridPoint("p0", emptyMap())),
                        emptyList(),
                    )
                }.isInstanceOf(CancellationException::class.java)
                assertThat(reads.get()).isEqualTo(1)
            }
        }
    }

    @Test
    fun `closing the executor preserves a checksummed manifest that can be resumed`() {
        val root = example("closed-executor")
        val workspace = FileWorkspace(root)
        ExperimentExecutor(1).use { executor ->
            assertThatThrownBy {
                Lab(workspace, executor = executor).run(experiment, "r", onProgress = { done, _ ->
                    if (done == 1) executor.close()
                })
            }.isInstanceOf(CancellationException::class.java)
        }
        val directory = ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r"
        val manifest = Json.decodeFromString(RunManifest.serializer(), workspace.read("$directory/manifest.json").text)
        assertThat(manifest.complete).isFalse()
        assertThat(manifest.parts).isNotEmpty()
        manifest.parts.forEach { (path, checksum) ->
            assertThat(DocumentVersion.of(workspace.readBytes("$directory/$path"))).isEqualTo(checksum)
        }
        assertThat(Lab(workspace).use { it.resume(directory) }.manifest.complete).isTrue()
    }

    @Test
    fun `closing the pool during finalization still publishes the complete artifact`() {
        val root = example("closed-finalization")
        val backing = FileWorkspace(root)
        val finalizing = AtomicBoolean()
        val first = AtomicBoolean(true)
        val reading = CountDownLatch(1)
        val release = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val workspace =
            object : Workspace by backing {
                override fun readBytes(path: String): ByteArray {
                    if (finalizing.get() && path.endsWith("/replication.json.gz") && first.compareAndSet(true, false)) {
                        reading.countDown()
                        check(release.await(30, TimeUnit.SECONDS))
                    }
                    return backing.readBytes(path)
                }
            }
        ExperimentExecutor(2).use { executor ->
            val caller =
                thread(isDaemon = true) {
                    try {
                        Lab(workspace, executor = executor).run(experiment, "r", onProgress = {
                            done,
                            total,
                            ->
                            finalizing.set(done == total)
                        })
                    } catch (exception: Throwable) {
                        failure.set(exception)
                    }
                }
            try {
                assertThat(reading.await(30, TimeUnit.SECONDS)).isTrue()
                executor.close()
                release.countDown()
                caller.join(30_000)
                assertThat(caller.isAlive).isFalse()
                assertThat(failure.get()).isNull()
                val directory = ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r"
                val manifest = Json.decodeFromString(RunManifest.serializer(), backing.read("$directory/manifest.json").text)
                assertThat(manifest.complete).isTrue()
                manifest.parts.forEach { (path, checksum) ->
                    assertThat(DocumentVersion.of(backing.readBytes("$directory/$path"))).isEqualTo(checksum)
                }
            } finally {
                release.countDown()
                caller.interrupt()
                caller.join(30_000)
            }
        }
    }

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
            val manifest =
                Json.decodeFromString(
                    RunManifest.serializer(),
                    backing.read(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r/manifest.json").text,
                )
            assertThat(manifest.complete).isFalse()
            assertThat(manifest.parts).isNotEmpty()
            assertThat(backing.exists(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r/summary.json")).isFalse()
            assertThat(manifest.parts.keys).hasSize(
                backing.listFiles(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r").size - 1,
            )
            manifest.parts.forEach { (path, checksum) ->
                assertThat(
                    DocumentVersion.of(
                        backing.readBytes(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r/$path"),
                    ),
                ).isEqualTo(checksum)
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
        val parallel = example("eight")
        val two = example("two")
        val four = example("four")
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
        run(parallel, 8)
        run(two, 2)
        run(four, 4)
        run(reordered, 8)
        val workspace = FileWorkspace(sequential)
        val storedManifest = Json.parseToJsonElement(workspace.read("${first.runDirectory}/manifest.json").text).jsonObject
        val snapshots = storedManifest["snapshots"]?.jsonObject
        assertThat(snapshots).isNotNull()
        first.manifest.documents.forEach { (path, hash) ->
            val text = snapshots!!.getValue(path).jsonPrimitive.content
            assertThat(DocumentVersion.of(text)).isEqualTo(hash)
        }
        val modelSnapshot =
            Json
                .parseToJsonElement(
                    snapshots!!.getValue("retry-storm/retry-storm.model.json").jsonPrimitive.content,
                ).jsonObject
        assertThat(modelSnapshot.getValue("connections").jsonArray.map { it.jsonObject["params"] }).doesNotContainNull()
        val experimentSnapshot = Json.parseToJsonElement(snapshots.getValue(experiment).jsonPrimitive.content).jsonObject
        assertThat(experimentSnapshot.getValue("variants").jsonArray.map { it.jsonObject["overrides"] }).doesNotContainNull()
        assertThat(experimentSnapshot["grid"]).isNotNull()
        val files = workspace.listFiles(first.runDirectory)
        assertThat(files).anyMatch { it.endsWith("/replication.json.gz") }.anyMatch { it.endsWith("/index.json") }
        val indexes = files.filter { it.endsWith("/index.json") }
        assertThat(indexes).hasSize(20)
        indexes.forEach { path ->
            val index = Json.decodeFromString(SeriesIndex.serializer(), workspace.read(path).text)
            assertThat(index.parts).hasSize(1)
            assertThat(index.parts.single().fromWindow).isZero()
            assertThat(index.parts.single().untilWindow).isEqualTo(100)
            assertThat(index.schemaVersion).isEqualTo(7)
            assertThat(index.parts.single().connections).containsExactly("gateway-to-middle", "middle-to-dependency")
        }
        for (path in files) {
            val bytes = workspace.readBytes(path)
            assertThat(Files.readAllBytes(parallel.resolve(path))).describedAs(path).isEqualTo(bytes)
            assertThat(Files.readAllBytes(two.resolve(path))).describedAs("2/$path").isEqualTo(bytes)
            assertThat(Files.readAllBytes(four.resolve(path))).describedAs("4/$path").isEqualTo(bytes)
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
            )
        assertThat(DocumentCodec.encode(RunSummary.serializer(), rebuilt))
            .isEqualTo(workspace.read("${first.runDirectory}/summary.json").text)
        assertThat(workspace.read("${first.runDirectory}/summary.json").text)
            .contains(
                "\"minimumDurationMs\": 100.0",
                "\"utilizationThreshold\": 0.95",
                "\"meanQueueLengthThreshold\": 0.5",
                "\"rejectionsThreshold\": 0",
            )
        assertThat(first.manifest.complete).isTrue()
        assertThat(first.manifest.schemaVersion).isEqualTo(18)
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
        val replicationText =
            GZIPInputStream(
                workspace.readBytes("${first.runDirectory}/series/baseline/p0/rep-0/replication.json.gz").inputStream(),
            ).bufferedReader(Charsets.UTF_8).use { it.readText() }
        val replication = Json.decodeFromString(ReplicationArtifact.serializer(), replicationText)
        assertThat(replication.result.entries.total.allLatency.count).isEqualTo(
            replication.result.entries.total.originalArrivals
                .toLong(),
        )
        assertThat(replicationText)
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
        val manifest =
            Json.decodeFromString(
                RunManifest.serializer(),
                backing.read(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r/manifest.json").text,
            )
        assertThat(manifest.complete).isFalse()
        assertThat(manifest.parts).isNotEmpty()
        assertThat(backing.exists(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r/summary.json")).isFalse()
        assertThat(manifest.parts.keys).hasSize(
            backing.listFiles(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/r").size - 1,
        )
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
