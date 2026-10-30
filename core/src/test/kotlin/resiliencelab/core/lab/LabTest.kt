package resiliencelab.core.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.FileWorkspace
import resiliencelab.core.workspace.VersionedDocument
import resiliencelab.core.workspace.Workspace
import resiliencelab.core.workspace.createSymbolicLink
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.io.path.copyTo
import kotlin.io.path.createDirectories
import kotlin.test.Test

class LabTest {
    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val model = "retry-storm/retry-storm.model.json"

    @TempDir
    lateinit var temp: Path

    private fun exampleWorkspace(): Path {
        val target = Files.createTempDirectory(temp, "lab-test")
        val source = Path.of("../examples")
        Files.walk(source.resolve("retry-storm")).use { paths ->
            paths.filter { Files.isRegularFile(it) }.forEach { file ->
                val destination = target.resolve(source.relativize(file).toString())
                destination.parent.createDirectories()
                file.copyTo(destination)
            }
        }
        return target
    }

    @Test
    fun `missing document diagnostics preserve legacy text and expose its path`() {
        Lab(FileWorkspace(temp)).use { lab ->
            val diagnostic = lab.validate("missing.experiment.json").diagnostics.single()

            assertThat(diagnostic.message).isEqualTo("Document 'missing.experiment.json' does not exist")
            assertThat(Json.encodeToJsonElement(diagnostic).jsonObject["args"])
                .isEqualTo(Json.parseToJsonElement("""{"path":"missing.experiment.json"}"""))
        }
    }

    @Test
    fun `validates draft model without replacing the saved document`() {
        val root = exampleWorkspace()
        val files = FileWorkspace(root)
        val original = files.read(model)
        val draft = original.text.replace("\"handlers\": 4", "\"handlers\": 0")

        Lab(files).use { lab ->
            val report = lab.validate(experiment, mapOf(model to draft))

            assertThat(report.valid).isFalse()
            assertThat(report.diagnostics).anySatisfy {
                assertThat(it.document).isEqualTo(model)
                assertThat(it.path).isEqualTo("gateway")
                assertThat(it.pointer).isEqualTo("/blocks/gateway/params/handlers")
            }
            assertThat(files.read(model)).isEqualTo(original)
            assertThat(lab.validate(experiment).valid).isTrue()
        }
    }

    @Test
    fun `validates newly created draft experiment model and layout together`() {
        val root = exampleWorkspace()
        val files = FileWorkspace(root)
        val drafts =
            mapOf(
                "new/new.experiment.json" to
                    files
                        .read(experiment)
                        .text
                        .replace("retry-storm.model.json", "new.model.json")
                        .replace("retry-storm.layout.json", "new.layout.json"),
                "new/new.model.json" to files.read(model).text,
                "new/new.layout.json" to """{"schemaVersion":1,"positions":{}}""",
            )

        Lab(files).use { lab ->
            assertThat(lab.validate("new/new.experiment.json", drafts).valid).isTrue()
        }
        assertThat(root.resolve("new")).doesNotExist()
    }

    @Test
    fun `drafts cannot bypass workspace path boundaries`() {
        val root = exampleWorkspace()
        Lab(FileWorkspace(root)).use { lab ->
            listOf("../escape.model.json", "/escape.model.json", "a/../escape.model.json").forEach { path ->
                assertThatThrownBy { lab.validate(experiment, mapOf(path to "{}")) }
                    .isInstanceOf(resiliencelab.core.workspace.InvalidDocumentPathException::class.java)
            }
        }
        val outside = temp.resolve("outside")
        Files.createDirectory(outside)
        createSymbolicLink(root.resolve("link"), outside)
        Lab(FileWorkspace(root)).use { lab ->
            assertThatThrownBy { lab.validate(experiment, mapOf("link/new.model.json" to "{}")) }
                .isInstanceOf(resiliencelab.core.workspace.InvalidDocumentPathException::class.java)
        }
    }

    @Test
    fun `a pre cancelled run leaves no artifact`() {
        val root = exampleWorkspace()

        Lab(FileWorkspace(root)).use { lab ->
            assertThatThrownBy { lab.run(experiment, "cancelled", isCancelled = { true }) }
                .isInstanceOf(CancellationException::class.java)
        }
        assertThat(root.resolve(".results")).doesNotExist()
    }

    @Test
    fun `cancellation at final progress retains task files with an incomplete manifest`() {
        val root = exampleWorkspace()
        val cancelled = AtomicBoolean()

        Lab(FileWorkspace(root)).use { lab ->
            assertThatThrownBy {
                lab.run(experiment, "cancelled", lab.validate(experiment).documentVersions, isCancelled = cancelled::get) { done, total ->
                    if (done == total) cancelled.set(true)
                }
            }.isInstanceOf(CancellationException::class.java)
        }
        assertIncomplete(root)
    }

    @Test
    fun `resumed and continuous artifacts are byte identical and a corrupt part is recomputed`() {
        val expectedRoot = exampleWorkspace()
        val actualRoot = exampleWorkspace()
        Lab(FileWorkspace(expectedRoot)).use { it.run(experiment, "run-1") }
        val cancelled = AtomicBoolean()
        Lab(FileWorkspace(actualRoot)).use { lab ->
            assertThatThrownBy {
                lab.run(experiment, "cancelled", isCancelled = cancelled::get) { done, _ ->
                    if (done == 1) cancelled.set(true)
                }
            }.isInstanceOf(CancellationException::class.java)
        }
        val runDirectory = ".results/retry-storm/cancelled"
        val corrupt = FileWorkspace(actualRoot).listFiles(runDirectory).first { it.endsWith(".json.gz") }
        Files.write(actualRoot.resolve(corrupt), byteArrayOf(1, 2, 3))

        val resumed = Lab(FileWorkspace(actualRoot)).use { it.resume(runDirectory) }

        assertThat(resumed.manifest.complete).isTrue()
        val expectedDirectory = ".results/retry-storm/run-1"
        val expectedFiles = FileWorkspace(expectedRoot).listFiles(expectedDirectory).map { it.removePrefix("$expectedDirectory/") }
        val actualFiles = FileWorkspace(actualRoot).listFiles(runDirectory).map { it.removePrefix("$runDirectory/") }
        assertThat(actualFiles).containsExactlyElementsOf(expectedFiles)
        expectedFiles.forEach { relative ->
            assertThat(Files.readAllBytes(actualRoot.resolve("$runDirectory/$relative")))
                .describedAs(relative)
                .containsExactly(*Files.readAllBytes(expectedRoot.resolve("$expectedDirectory/$relative")))
        }
    }

    @Test
    fun `resume accepts a current run after connections are reordered`() {
        val root = exampleWorkspace()
        createIncomplete(root)
        val modelPath = root.resolve(model)
        val decoded = (DocumentCodec.decodeModel(Files.readString(modelPath), model) as DecodeResult.Ok).value
        Files.writeString(modelPath, DocumentCodec.encodeModel(decoded.copy(connections = decoded.connections.reversed())))
        val runDirectory = ".results/retry-storm/cancelled"

        Lab(FileWorkspace(root)).use { lab ->
            assertThat(lab.validateResume(runDirectory).complete).isFalse()
            assertThat(lab.resume(runDirectory).manifest.complete).isTrue()
        }
    }

    @Test
    fun `resume rejects changed documents without mutating the artifact`() {
        val root = exampleWorkspace()
        createIncomplete(root)
        val runDirectory = ".results/retry-storm/cancelled"
        val modelFile = root.resolve(model)
        Files.writeString(modelFile, Files.readString(modelFile).replace("\"handlers\": 4", "\"handlers\": 5"))
        val before = artifactHashes(FileWorkspace(root), runDirectory)

        val failure = runCatching { Lab(FileWorkspace(root)).use { it.resume(runDirectory) } }.exceptionOrNull()

        assertThat(failure).isInstanceOf(InvalidExperimentException::class.java)
        assertThat((failure as InvalidExperimentException).diagnostics.single().code).isEqualTo("RUN_DOCUMENT_CHANGED")
        assertThat(failure.message).contains("run again")
        assertThat(artifactHashes(FileWorkspace(root), runDirectory)).isEqualTo(before)
    }

    @Test
    fun `resume preflight preserves a valid incomplete artifact and does not execute tasks`() {
        val root = exampleWorkspace()
        createIncomplete(root)
        val runDirectory = ".results/retry-storm/cancelled"
        val before = artifactHashes(FileWorkspace(root), runDirectory)
        val calls = AtomicInteger()
        val executor =
            ExperimentExecutor(workers = 1) { _, _, _, _ ->
                calls.incrementAndGet()
                error("Preflight must not start KSL")
            }

        val manifest = Lab(FileWorkspace(root), executor = executor).use { it.validateResume(runDirectory) }
        executor.close()

        assertThat(manifest.complete).isFalse()
        assertThat(calls.get()).isZero()
        assertThat(artifactHashes(FileWorkspace(root), runDirectory)).isEqualTo(before)
    }

    @Test
    fun `resume preflight rejects a complete artifact without mutating it`() {
        val root = exampleWorkspace()
        val runDirectory = ".results/retry-storm/cancelled"
        Lab(FileWorkspace(root)).use { it.run(experiment, "cancelled") }
        val before = artifactHashes(FileWorkspace(root), runDirectory)

        val failure = runCatching { Lab(FileWorkspace(root)).use { it.validateResume(runDirectory) } }.exceptionOrNull()

        assertThat(failure).isInstanceOf(InvalidExperimentException::class.java)
        assertThat((failure as InvalidExperimentException).diagnostics.single().code).isEqualTo("RUN_COMPLETE")
        assertThat(artifactHashes(FileWorkspace(root), runDirectory)).isEqualTo(before)
    }

    @Test
    fun `resume preflight rejects changed documents without mutating the artifact`() {
        val root = exampleWorkspace()
        createIncomplete(root)
        val runDirectory = ".results/retry-storm/cancelled"
        val modelFile = root.resolve(model)
        Files.writeString(modelFile, Files.readString(modelFile).replace("\"handlers\": 4", "\"handlers\": 5"))
        val before = artifactHashes(FileWorkspace(root), runDirectory)

        val failure = runCatching { Lab(FileWorkspace(root)).use { it.validateResume(runDirectory) } }.exceptionOrNull()

        assertThat(failure).isInstanceOf(InvalidExperimentException::class.java)
        assertThat((failure as InvalidExperimentException).diagnostics.single().code).isEqualTo("RUN_DOCUMENT_CHANGED")
        assertThat(artifactHashes(FileWorkspace(root), runDirectory)).isEqualTo(before)
    }

    @Test
    fun `resume rejects an incompatible application without mutating the artifact`() {
        val root = exampleWorkspace()
        createIncomplete(root)
        val runDirectory = ".results/retry-storm/cancelled"
        val manifest = root.resolve("$runDirectory/manifest.json")
        Files.writeString(manifest, Files.readString(manifest).replace("0.1.0", "0.2.0"))
        val before = artifactHashes(FileWorkspace(root), runDirectory)

        val failure = runCatching { Lab(FileWorkspace(root)).use { it.resume(runDirectory) } }.exceptionOrNull()

        assertThat(failure).isInstanceOf(InvalidExperimentException::class.java)
        assertThat((failure as InvalidExperimentException).diagnostics.single().code).isEqualTo("RUN_INCOMPATIBLE")
        assertThat(artifactHashes(FileWorkspace(root), runDirectory)).isEqualTo(before)
    }

    @Test
    fun `resume rebuilds summary without executing valid tasks`() {
        val root = exampleWorkspace()
        val runDirectory = ".results/retry-storm/cancelled"
        Lab(FileWorkspace(root)).use { it.run(experiment, "cancelled") }
        val originalManifest = Files.readAllBytes(root.resolve("$runDirectory/manifest.json"))
        val originalSummary = Files.readAllBytes(root.resolve("$runDirectory/summary.json"))
        Files.writeString(
            root.resolve("$runDirectory/manifest.json"),
            Files.readString(root.resolve("$runDirectory/manifest.json")).replace("\"complete\": true", "\"complete\": false"),
        )
        Files.delete(root.resolve("$runDirectory/summary.json"))
        val calls = AtomicInteger()
        val executor =
            ExperimentExecutor(workers = 1) { _, _, _, _ ->
                calls.incrementAndGet()
                error("A valid task must not be recomputed")
            }

        val resumed = Lab(FileWorkspace(root), executor = executor).use { it.resume(runDirectory) }
        executor.close()

        assertThat(calls.get()).isZero()
        assertThat(resumed.manifest.complete).isTrue()
        assertThat(Files.readAllBytes(root.resolve("$runDirectory/manifest.json"))).containsExactly(*originalManifest)
        assertThat(Files.readAllBytes(root.resolve("$runDirectory/summary.json"))).containsExactly(*originalSummary)
    }

    @Test
    fun `cancellation during resume leaves a resumable artifact without summary`() {
        val root = exampleWorkspace()
        createIncomplete(root)
        val runDirectory = ".results/retry-storm/cancelled"
        val missing = FileWorkspace(root).listFiles(runDirectory).first { it.endsWith("/replication.json") }
        Files.delete(root.resolve(missing))
        val cancelled = AtomicBoolean()

        assertThatThrownBy {
            Lab(FileWorkspace(root)).use { lab ->
                lab.resume(runDirectory, isCancelled = cancelled::get) { done, total ->
                    if (total > 0 && done == total) cancelled.set(true)
                }
            }
        }.isInstanceOf(CancellationException::class.java)

        assertIncomplete(root)
        val resumed = Lab(FileWorkspace(root)).use { it.resume(runDirectory) }
        assertThat(resumed.manifest.complete).isTrue()
        assertThat(root.resolve("$runDirectory/summary.json")).isRegularFile()
    }

    @Test
    fun `concurrent resumes serialize and the second sees a completed run`() {
        val root = exampleWorkspace()
        val runDirectory = ".results/retry-storm/cancelled"
        Lab(FileWorkspace(root)).use { it.run(experiment, "cancelled") }
        val manifestPath = root.resolve("$runDirectory/manifest.json")
        Files.writeString(manifestPath, Files.readString(manifestPath).replace("\"complete\": true", "\"complete\": false"))
        Files.delete(root.resolve("$runDirectory/summary.json"))
        Files.delete(root.resolve("$runDirectory/series/baseline/p0/rep-0/replication.json"))
        Files.delete(root.resolve("$runDirectory/series/no-retries/p0/rep-0/replication.json"))
        val backing = FileWorkspace(root)
        val manifestReads = AtomicInteger()
        val workspace =
            object : Workspace by backing {
                override fun read(path: String): VersionedDocument {
                    if (path == "$runDirectory/manifest.json") manifestReads.incrementAndGet()
                    return backing.read(path)
                }
            }
        val timeoutSeconds = 30L
        val firstProgress = CountDownLatch(1)
        val release = CountDownLatch(1)
        val first =
            FutureTask<Throwable?> {
                runCatching {
                    Lab(workspace).use { lab ->
                        lab.resume(runDirectory) { done, _ ->
                            if (done == 1) {
                                firstProgress.countDown()
                                check(release.await(timeoutSeconds, TimeUnit.SECONDS))
                            }
                        }
                    }
                }.exceptionOrNull()
            }
        val firstThread = thread(isDaemon = true) { first.run() }
        val secondStarted = CountDownLatch(1)
        val second =
            FutureTask<Throwable?> {
                secondStarted.countDown()
                runCatching { Lab(workspace).use { it.resume(runDirectory) } }.exceptionOrNull()
            }
        var secondThread: Thread? = null

        try {
            val progressed = firstProgress.await(timeoutSeconds, TimeUnit.SECONDS)
            if (!progressed) {
                release.countDown()
                assertThat(first.get(timeoutSeconds, TimeUnit.SECONDS)).isNull()
            }
            assertThat(progressed).isTrue()
            val runningSecond = thread(isDaemon = true) { second.run() }
            secondThread = runningSecond
            assertThat(secondStarted.await(timeoutSeconds, TimeUnit.SECONDS)).isTrue()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
            while (runningSecond.state != Thread.State.BLOCKED && manifestReads.get() == 1 && System.nanoTime() < deadline) {
                Thread.yield()
            }
            assertThat(manifestReads.get()).isEqualTo(1)
            assertThat(runningSecond.state).isEqualTo(Thread.State.BLOCKED)
            release.countDown()
            assertThat(first.get(timeoutSeconds, TimeUnit.SECONDS)).isNull()
            val secondFailure = second.get(timeoutSeconds, TimeUnit.SECONDS)
            assertThat(secondFailure).isInstanceOf(InvalidExperimentException::class.java)
            assertThat((secondFailure as InvalidExperimentException).diagnostics.single().code).isEqualTo("RUN_COMPLETE")
        } finally {
            release.countDown()
            firstThread.interrupt()
            secondThread?.interrupt()
            firstThread.join(5_000)
            secondThread?.join(5_000)
        }
    }

    @Test
    fun `caller interruption after summary creation still completes the manifest`() {
        val root = exampleWorkspace()
        val caller = Thread.currentThread()
        val files = FileWorkspace(root)
        val workspace =
            object : Workspace by files {
                override fun create(
                    path: String,
                    text: String,
                ): String {
                    val version = files.create(path, text)
                    if (path.endsWith("/summary.json")) caller.interrupt()
                    return version
                }
            }

        try {
            val outcome = Lab(workspace).use { it.run(experiment, "run-1") }
            assertThat(Thread.interrupted()).isTrue()
            assertThat(outcome.manifest.complete).isTrue()
            assertThat(root.resolve("${outcome.runDirectory}/summary.json")).isRegularFile()
            assertThat(root.resolve("${outcome.runDirectory}/manifest.json")).isRegularFile()
        } finally {
            Thread.interrupted()
        }
    }

    @Test
    fun `a concurrent cancelled job does not change artifact bytes`() {
        val expectedRoot = exampleWorkspace()
        val actualRoot = exampleWorkspace()
        val cancelledRoot = exampleWorkspace()
        val cancelledFile = cancelledRoot.resolve(experiment)
        val original = Files.readString(cancelledFile)
        val shortened = original.replace("\"replications\": 10", "\"replications\": 1")
        assertThat(shortened).isNotEqualTo(original)
        Files.writeString(cancelledFile, shortened)
        ExperimentExecutor(workers = 1).use { executor ->
            Lab(FileWorkspace(expectedRoot), executor = executor).use { it.run(experiment, "run-1") }
        }

        val cancelled = AtomicBoolean()
        val firstProgress = CountDownLatch(1)
        val release = CountDownLatch(1)
        ExperimentExecutor(workers = 3).use { executor ->
            val cancelledRun =
                FutureTask {
                    runCatching {
                        Lab(FileWorkspace(cancelledRoot), executor = executor).use { lab ->
                            lab.run(experiment, "cancelled", isCancelled = cancelled::get) { done, _ ->
                                if (done == 1) {
                                    firstProgress.countDown()
                                    check(release.await(5, TimeUnit.SECONDS))
                                }
                            }
                        }
                    }.exceptionOrNull()
                }
            val runner = thread(isDaemon = true) { cancelledRun.run() }
            try {
                assertThat(firstProgress.await(5, TimeUnit.SECONDS)).isTrue()
                Lab(FileWorkspace(actualRoot), executor = executor).use { lab ->
                    lab.run(experiment, "run-1") { _, _ ->
                        cancelled.set(true)
                        release.countDown()
                    }
                }
                assertThat(cancelledRun.get(3, TimeUnit.SECONDS)).isInstanceOf(CancellationException::class.java)
            } finally {
                cancelled.set(true)
                release.countDown()
                runner.interrupt()
                runner.join(5_000)
            }
        }

        assertIncomplete(cancelledRoot)
        listOf("manifest.json", "summary.json").forEach { file ->
            val relative = ".results/retry-storm/run-1/$file"
            assertThat(
                Files.readAllBytes(actualRoot.resolve(relative)),
            ).containsExactly(*Files.readAllBytes(expectedRoot.resolve(relative)))
        }
    }

    private fun createIncomplete(root: Path) {
        val cancelled = AtomicBoolean()
        Lab(FileWorkspace(root)).use { lab ->
            assertThatThrownBy {
                lab.run(experiment, "cancelled", isCancelled = cancelled::get) { done, _ ->
                    if (done == 1) cancelled.set(true)
                }
            }.isInstanceOf(CancellationException::class.java)
        }
        assertIncomplete(root)
    }

    private fun artifactHashes(
        workspace: FileWorkspace,
        runDirectory: String,
    ): Map<String, String> =
        workspace.listFiles(runDirectory).associateWith { path ->
            resiliencelab.core.workspace.DocumentVersion
                .of(workspace.readBytes(path))
        }

    private fun assertIncomplete(root: Path) {
        val directory = root.resolve(".results/retry-storm/cancelled")
        assertThat(Files.readString(directory.resolve("manifest.json"))).contains("\"complete\": false")
        assertThat(directory.resolve("summary.json")).doesNotExist()
        assertThat(FileWorkspace(root).listFiles(".results/retry-storm/cancelled"))
            .anyMatch { it.endsWith("/replication.json") }
    }

    @Test
    fun `validates the example with advisory warnings for baseline only`() {
        val report = Lab(FileWorkspace(exampleWorkspace())).validate(experiment)

        assertThat(report.diagnostics.map { it.code }).containsExactly("LINT_TIMEOUT_BUDGET")
        assertThat(report.diagnostics).allSatisfy {
            assertThat(it.severity).isEqualTo(resiliencelab.core.compiler.Severity.WARNING)
            assertThat(it.document).isEqualTo(model)
            assertThat(it.variant).isEqualTo("baseline")
            assertThat(it.message).doesNotContain("variants:")
        }
        assertThat(report.diagnostics.single { it.code == "LINT_TIMEOUT_BUDGET" }.message)
            .isEqualTo("Timeout 80 ms is below the downstream budget 189 ms")
        assertThat(report.valid).isTrue()
    }

    @Test
    fun `estimates the example without executing a model or writing results`() {
        val root = exampleWorkspace()
        val calls = AtomicInteger()
        val executor =
            ExperimentExecutor(workers = 1) { _, _, _, _ ->
                calls.incrementAndGet()
                error("Estimation must not start KSL")
            }

        val estimate = Lab(FileWorkspace(root), executor = executor).use { it.estimate(experiment, workers = 1) }
        executor.close()

        assertThat(calls.get()).isZero()
        assertThat(estimate.tasks).isEqualTo(20)
        assertThat(estimate.expectedEvents).isPositive()
        assertThat(estimate.expectedRows).isEqualTo(8_000)
        assertThat(estimate.estimatedParts).isEqualTo(20)
        assertThat(estimate.estimatedSeconds).isPositive()
        assertThat(estimate.estimatedArtifactBytes).isPositive()
        assertThat(root.resolve(".results")).doesNotExist()
    }

    @Test
    fun `estimate uses drafts and rejects invalid worker counts`() {
        val root = exampleWorkspace()
        val files = FileWorkspace(root)
        val original = files.read(model)
        val draft = original.text.replace("120/s", "240/s")
        Lab(files).use { lab ->
            val baseline = lab.estimate(experiment, workers = 1)
            val changed = lab.estimate(experiment, mapOf(model to draft), workers = 1)

            assertThat(changed.expectedEvents).isGreaterThan(baseline.expectedEvents)
            assertThat(changed.estimatedSeconds).isGreaterThan(baseline.estimatedSeconds)
            assertThatThrownBy { lab.estimate(experiment, workers = 0) }.isInstanceOf(IllegalArgumentException::class.java)
        }
        assertThat(files.read(model)).isEqualTo(original)
        assertThat(root.resolve(".results")).doesNotExist()
    }

    @Test
    fun `example time estimate is within eight times of measured execution`() {
        val root = exampleWorkspace()
        ExperimentExecutor(workers = 1).use { executor ->
            Lab(FileWorkspace(root), executor = executor).use { lab ->
                lab.run(experiment, "warmup")
                val estimate = lab.estimate(experiment, workers = 1)
                val started = System.nanoTime()
                lab.run(experiment, "measured")
                val measuredSeconds = (System.nanoTime() - started) / 1_000_000_000.0
                val ratio =
                    maxOf(
                        estimate.estimatedSeconds / measuredSeconds,
                        measuredSeconds / estimate.estimatedSeconds,
                    )
                println(
                    "retry-storm cost calibration: estimate=${estimate.estimatedSeconds}s, " +
                        "measured=${measuredSeconds}s, ratio=$ratio",
                )
                assertThat(ratio).isLessThanOrEqualTo(8.0)
            }
        }
    }

    @Test
    fun `reports missing and unreadable documents and broken references`() {
        val root = exampleWorkspace()
        val lab = Lab(FileWorkspace(root))

        val experimentFile = root.resolve(experiment)
        val original = Files.readString(experimentFile)

        assertThat(
            lab
                .validate("missing.experiment.json")
                .diagnostics
                .single()
                .code,
        ).isEqualTo("DOCUMENT_MISSING")

        Files.writeString(experimentFile, original.replace("retry-storm.model.json", "gone.model.json"))
        assertThat(
            lab
                .validate(experiment)
                .diagnostics
                .single()
                .code,
        ).isEqualTo("MODEL_REF")

        Files.writeString(experimentFile, original.replace("retry-storm.model.json", "../../x.model.json"))
        assertThat(
            lab
                .validate(experiment)
                .diagnostics
                .single()
                .code,
        ).isEqualTo("MODEL_REF")

        Files.writeString(experimentFile, original)
        Files.writeString(root.resolve(model), "{")
        assertThat(
            lab
                .validate(experiment)
                .diagnostics
                .single()
                .code,
        ).isEqualTo("JSON_SYNTAX")

        Files.write(root.resolve(model), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))
        assertThat(
            lab
                .validate(experiment)
                .diagnostics
                .single()
                .code,
        ).isEqualTo("DOCUMENT_UNREADABLE")
    }

    @Test
    fun `checks the layout reference and the layout document`() {
        val root = exampleWorkspace()
        val lab = Lab(FileWorkspace(root))
        val experimentFile = root.resolve(experiment)
        val original = Files.readString(experimentFile)

        Files.writeString(experimentFile, original.replace("retry-storm.layout.json", "https://example.invalid/layout.json"))
        val remote = lab.validate(experiment).diagnostics.single()
        assertThat(remote.code to remote.pointer).isEqualTo("LAYOUT_REF" to "/layoutRef")

        Files.writeString(experimentFile, original.replace("retry-storm.layout.json", "gone.layout.json"))
        assertThat(
            lab
                .validate(experiment)
                .diagnostics
                .single()
                .code,
        ).isEqualTo("LAYOUT_REF")

        Files.writeString(experimentFile, original)
        Files.writeString(root.resolve("retry-storm/retry-storm.layout.json"), "{")
        val broken = lab.validate(experiment)
        assertThat(broken.valid).isFalse()
        assertThat(broken.diagnostics.single().code).isEqualTo("JSON_SYNTAX")
    }

    @Test
    fun `refuses run ids that would leave the results directory before computing`() {
        val root = exampleWorkspace()

        assertThatThrownBy { Lab(FileWorkspace(root)).run(experiment, "../..") }.isInstanceOf(IllegalArgumentException::class.java)
        assertThat(root.resolve(".results")).doesNotExist()
        assertThat(root.resolve("summary.json")).doesNotExist()
    }

    @Test
    fun `refuses to run an invalid experiment`() {
        val lab = Lab(FileWorkspace(exampleWorkspace()))

        assertThatThrownBy { lab.run("missing.experiment.json", "run-1") }.isInstanceOf(InvalidExperimentException::class.java)
    }

    @Test
    fun `runs the example into a reproducible artifact`() {
        val sequentialRoot = exampleWorkspace()
        val parallelRoot = exampleWorkspace()

        val outcome =
            ExperimentExecutor(workers = 1).use { executor ->
                Lab(FileWorkspace(sequentialRoot), executor = executor).use { it.run(experiment, "run-1") }
            }
        ExperimentExecutor(workers = 3).use { executor ->
            Lab(FileWorkspace(parallelRoot), executor = executor).use { it.run(experiment, "run-1") }
        }

        assertThat(outcome.runDirectory).isEqualTo(".results/retry-storm/run-1")
        assertThat(outcome.summary.variants.map { it.id }).containsExactly("baseline", "no-retries")
        assertThat(outcome.summary.variants.map { it.label }).containsExactly("Baseline", "No retries")
        val writtenSummary = Files.readString(sequentialRoot.resolve(".results/retry-storm/run-1/summary.json"))
        assertThat(writtenSummary).contains("\"label\": \"No retries\"")
        assertThat(outcome.manifest.documents.keys).containsExactly(experiment, model)
        listOf("summary.json", "manifest.json").forEach { file ->
            val relative = ".results/retry-storm/run-1/$file"
            assertThat(Files.readString(parallelRoot.resolve(relative))).isEqualTo(Files.readString(sequentialRoot.resolve(relative)))
        }
    }

    @Test
    fun `block order in the model does not change the summary`() {
        val originalRoot = exampleWorkspace()
        val reorderedRoot = exampleWorkspace()
        val reordered =
            Files.readString(reorderedRoot.resolve(model)).let { text ->
                val start = text.indexOf("\"blocks\": {")
                val end = text.indexOf("\n  },\n  \"connections\"")
                val body = text.substring(start + "\"blocks\": {".length, end)
                val entries = Regex("""\n    "[^"]+": \{[\s\S]*?\n    }""").findAll(body).map { it.value }.toList()
                text.substring(0, start) + "\"blocks\": {" + entries.reversed().joinToString(",") + text.substring(end)
            }
        Files.writeString(reorderedRoot.resolve(model), reordered)

        Lab(FileWorkspace(originalRoot)).use { it.run(experiment, "run-1") }
        Lab(FileWorkspace(reorderedRoot)).use { it.run(experiment, "run-1") }

        val summary = ".results/retry-storm/run-1/summary.json"
        assertThat(Files.readString(reorderedRoot.resolve(summary))).isEqualTo(Files.readString(originalRoot.resolve(summary)))
    }

    @Test
    fun `preserves existing artifact when run id is repeated`() {
        val root = exampleWorkspace()
        val lab = Lab(FileWorkspace(root))
        val summaryPath = root.resolve(".results/retry-storm/run-1/summary.json")
        val manifestPath = root.resolve(".results/retry-storm/run-1/manifest.json")
        lab.use {
            it.run(experiment, "run-1")
            val originalSummary = Files.readAllBytes(summaryPath)
            val originalManifest = Files.readAllBytes(manifestPath)

            assertThatThrownBy { it.run(experiment, "run-1") }.isInstanceOf(DocumentExistsException::class.java)
            assertThat(Files.readAllBytes(summaryPath)).containsExactly(*originalSummary)
            assertThat(Files.readAllBytes(manifestPath)).containsExactly(*originalManifest)
        }
    }

    @Test
    fun `closes owned worker threads when the facade closes`() {
        val threadsBeforeRun = Thread.getAllStackTraces().keys.toSet()
        val lab = Lab(FileWorkspace(exampleWorkspace()))
        val ownedWorkers = mutableListOf<Thread>()

        try {
            lab.run(experiment, "run-1")
            ownedWorkers +=
                Thread.getAllStackTraces().keys.filter { thread ->
                    thread !in threadsBeforeRun && thread.name == "experiment-task"
                }
            assertThat(ownedWorkers).isNotEmpty()
        } finally {
            lab.close()
        }

        ownedWorkers.forEach { it.join(2_000) }
        assertThat(ownedWorkers).allMatch { !it.isAlive }
    }

    @Test
    fun `closing an injected executor facade leaves shared execution usable`() {
        val root = exampleWorkspace()
        val sharedExecutor = ExperimentExecutor(workers = 1)

        try {
            Lab(FileWorkspace(root), executor = sharedExecutor).close()
            val outcome =
                Lab(FileWorkspace(root), executor = sharedExecutor).use { it.run(experiment, "run-after-close") }

            assertThat(outcome.summary.variants.map { it.id }).containsExactly("baseline", "no-retries")
        } finally {
            sharedExecutor.close()
        }
    }

    @Test
    fun `resolves references relative to the document directory`() {
        assertThat(Lab.resolveRef("a/b.experiment.json", "m.model.json")).isEqualTo("a/m.model.json")
        assertThat(Lab.resolveRef("a/b.experiment.json", "../m.model.json")).isEqualTo("m.model.json")
        assertThat(Lab.resolveRef("b.experiment.json", "./x/m.model.json")).isEqualTo("x/m.model.json")
        assertThat(Lab.resolveRef("b.experiment.json", "../m.model.json")).isNull()
        assertThat(Lab.resolveRef("b.experiment.json", "/m.model.json")).isNull()
        assertThat(Lab.resolveRef("b.experiment.json", "https://x/m.model.json")).isNull()
    }

    @Test
    fun `rejects changed validated inputs before computing`() {
        listOf(
            Triple(experiment, "20261025", "20261026"),
            Triple(model, "\"handlers\": 2", "\"handlers\": 3"),
        ).forEach { (path, before, after) ->
            val root = exampleWorkspace()
            Lab(FileWorkspace(root)).use { lab ->
                val report = lab.validate(experiment)
                val file = root.resolve(path)
                val original = Files.readString(file)
                val changed = original.replace(before, after)
                assertThat(changed).isNotEqualTo(original)
                Files.writeString(file, changed)

                val failure = runCatching { lab.run(experiment, "changed-input", report.documentVersions) }.exceptionOrNull()
                assertThat(failure).isInstanceOf(InvalidExperimentException::class.java)
                assertThat((failure as InvalidExperimentException).diagnostics.map { it.code }).containsExactly("DOCUMENT_CHANGED")
                assertThat(root.resolve(".results")).doesNotExist()
            }
        }
    }
}
