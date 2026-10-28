package resiliencelab.core.lab

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.FileWorkspace
import resiliencelab.core.workspace.Workspace
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
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
        Files.createSymbolicLink(root.resolve("link"), outside)
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
    fun `cancellation at final progress leaves no artifact`() {
        val root = exampleWorkspace()
        val cancelled = AtomicBoolean()

        Lab(FileWorkspace(root)).use { lab ->
            assertThatThrownBy {
                lab.run(experiment, "cancelled", lab.validate(experiment).documentVersions, isCancelled = cancelled::get) { done, total ->
                    if (done == total) cancelled.set(true)
                }
            }.isInstanceOf(CancellationException::class.java)
        }
        assertThat(root.resolve(".results")).doesNotExist()
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
        val shortened = original.replace("\"replications\": 2", "\"replications\": 1")
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

        assertThat(cancelledRoot.resolve(".results")).doesNotExist()
        listOf("manifest.json", "summary.json").forEach { file ->
            val relative = ".results/retry-storm/run-1/$file"
            assertThat(
                Files.readAllBytes(actualRoot.resolve(relative)),
            ).containsExactly(*Files.readAllBytes(expectedRoot.resolve(relative)))
        }
    }

    @Test
    fun `validates the example with advisory warnings for baseline only`() {
        val report = Lab(FileWorkspace(exampleWorkspace())).validate(experiment)

        assertThat(report.diagnostics.map { it.code }).containsExactlyInAnyOrder("LINT_TIMEOUT_BUDGET", "LINT_DEADLINE_BUDGET")
        assertThat(report.diagnostics).allSatisfy {
            assertThat(it.severity).isEqualTo(resiliencelab.core.compiler.Severity.WARNING)
            assertThat(it.document).isEqualTo(model)
            assertThat(it.message).contains("baseline").doesNotContain("no-retries")
        }
        assertThat(report.diagnostics.single { it.code == "LINT_TIMEOUT_BUDGET" }.message).contains("80", "189")
        assertThat(report.diagnostics.single { it.code == "LINT_DEADLINE_BUDGET" }.message).contains("250", "420")
        assertThat(report.valid).isTrue()
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
