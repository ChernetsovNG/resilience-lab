package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.http.converter.json.KotlinSerializationJsonHttpMessageConverter
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import resiliencelab.core.lab.Lab
import resiliencelab.core.results.RunCatalog
import java.nio.file.Files
import java.util.concurrent.CancellationException
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

class RunCleanupApiTest {
    private val root = TestWorkspace.copy()
    private val workspace = resiliencelab.core.workspace.FileWorkspace(root)
    private val lab = Lab(workspace)
    private val pending = mutableListOf<Runnable>()
    private val jobs = JobService(lab, Executor { pending += it }) { "queued-run" }
    private val runs = RunCatalog(workspace)
    private val mvc =
        MockMvcBuilders
            .standaloneSetup(RunController(runs, jobs), DocumentController(workspace, jobs))
            .setControllerAdvice(LabExceptionHandler())
            .setMessageConverters(KotlinSerializationJsonHttpMessageConverter(Json { encodeDefaults = true }))
            .build()
    private val experiment = "retry-storm/retry-storm.experiment.json"

    @AfterEach
    fun close() {
        jobs.close()
        lab.close()
        workspace.close()
    }

    @Test
    fun `deletes the whole run directory and returns 404 on repetition`() {
        val run = lab.run(experiment, "delete-me")
        assertThat(
            mvc
                .perform(delete("/api/v1/runs/delete-me"))
                .andReturn()
                .response.status,
        ).isEqualTo(204)
        assertThat(root.resolve(run.runDirectory)).doesNotExist()
        val repeated = mvc.perform(delete("/api/v1/runs/delete-me")).andReturn().response
        assertThat(repeated.status).isEqualTo(404)
        assertThat(repeated.contentAsString).contains("RUN_NOT_FOUND")
        assertThat(runs.list()).isEmpty()
    }

    @Test
    fun `lists old malformed and manifestless runs with size and available experiment`() {
        lab.run(experiment, "readable")
        workspace.write(".results/old/v1/manifest.json", """{"schemaVersion":1,"experiment":"other/same.experiment.json"}""")
        workspace.write(".results/old/broken/manifest.json", "{")
        workspace.write(".results/old/missing/part.gz", "12345")
        Files.createDirectories(root.resolve(".results/old/empty"))
        Files.createDirectories(root.resolve(".results/old/ "))
        val response = mvc.perform(get("/api/v1/runs/obsolete")).andReturn().response
        assertThat(response.status).isEqualTo(200)
        val entries = Json.parseToJsonElement(response.contentAsString).jsonArray.map { it.jsonObject }
        assertThat(entries.map { it.getValue("directory").jsonPrimitive.content })
            .containsExactlyInAnyOrder(
                ".results/old/v1",
                ".results/old/broken",
                ".results/old/missing",
                ".results/old/empty",
                ".results/old/ ",
            )
        val old = entries.single { it.getValue("id").jsonPrimitive.content == "v1" }
        assertThat(old.getValue("experiment").jsonPrimitive.content).isEqualTo("other/same.experiment.json")
        assertThat(
            old
                .getValue("sizeBytes")
                .jsonPrimitive.content
                .toLong(),
        ).isEqualTo(Files.size(root.resolve(".results/old/v1/manifest.json")))
        assertThat(
            entries
                .single { it.getValue("id").jsonPrimitive.content == "missing" }
                .getValue("sizeBytes")
                .jsonPrimitive.content,
        ).isEqualTo("5")
        assertThat(
            mvc
                .perform(delete("/api/v1/runs/v1"))
                .andReturn()
                .response.status,
        ).isEqualTo(204)
        assertThat(
            mvc
                .perform(delete("/api/v1/runs").param("directory", ".results/old/missing"))
                .andReturn()
                .response.status,
        ).isEqualTo(204)
        assertThat(root.resolve(".results/old/missing")).doesNotExist()
        assertThat(
            mvc
                .perform(delete("/api/v1/runs").param("directory", ".results/old/ "))
                .andReturn()
                .response.status,
        ).isEqualTo(204)
    }

    @Test
    fun `rejects traversal results roots and symlink escapes without deleting their files`() {
        val protected = root.resolve("outside/keep.txt")
        Files.createDirectories(protected.parent)
        Files.writeString(protected, "keep")
        Files.createDirectories(root.resolve(".results/old"))
        Files.createSymbolicLink(root.resolve(".results/old/link"), protected.parent)
        for (path in listOf("../outside", "outside", ".results", ".results/old", ".results/../outside", ".results/old/link")) {
            val response = mvc.perform(delete("/api/v1/runs").param("directory", path)).andReturn().response
            assertThat(response.status).describedAs(path).isIn(400, 404)
        }
        assertThat(Files.readString(protected)).isEqualTo("keep")
        assertThat(
            mvc
                .perform(get("/api/v1/runs/obsolete"))
                .andReturn()
                .response.contentAsString,
        ).doesNotContain("link")
    }

    @Test
    fun `queued launch prevents deletion before an artifact exists`() {
        val job = jobs.submit(experiment)
        val response = mvc.perform(delete("/api/v1/runs/{id}", job.runId)).andReturn().response
        assertThat(response.status).isEqualTo(409)
        assertThat(response.contentAsString).contains("RUN_ACTIVE", experiment, job.id)
        val document =
            mvc
                .perform(
                    delete(
                        "/api/v1/workspace/document",
                    ).param("path", experiment).header("If-Match", "\"${workspace.read(experiment).version}\""),
                ).andReturn()
                .response
        assertThat(document.status).isEqualTo(409)
        assertThat(root.resolve(experiment)).exists()
    }

    @Test
    fun `a job registered during directory enumeration is not offered for cleanup`() {
        val submitted = AtomicBoolean()
        val racingWorkspace =
            object : resiliencelab.core.workspace.Workspace by workspace {
                override fun listDirectories(directory: String): List<String> {
                    if (directory == ".results" && submitted.compareAndSet(false, true)) {
                        jobs.submit(experiment)
                        workspace.write(
                            ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/queued-run/part.gz",
                            "unfinished",
                        )
                    }
                    return workspace.listDirectories(directory)
                }
            }
        val entries = RunController(RunCatalog(racingWorkspace), jobs).listObsoleteRuns()
        assertThat(entries).isEmpty()
        assertThat(root.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/queued-run/part.gz")).exists()
    }

    @Test
    fun `a run that becomes readable while its size is collected is not offered for cleanup`() {
        val directory = ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/finishing"
        Files.createDirectories(root.resolve(directory))
        val finished = AtomicBoolean()
        val racingWorkspace =
            object : resiliencelab.core.workspace.Workspace by workspace {
                override fun directorySize(directory: String): Long {
                    if (finished.compareAndSet(false, true)) lab.run(experiment, "finishing")
                    return workspace.directorySize(directory)
                }
            }
        assertThat(RunController(RunCatalog(racingWorkspace), jobs).listObsoleteRuns()).isEmpty()
        assertThat(runs.entry("finishing")?.complete).isTrue()
    }

    @Test
    fun `lexical and in-workspace symlink aliases share ownership and active job guards`() {
        Files.createSymbolicLink(root.resolve("alias"), root.resolve("retry-storm"))
        lab.run("./$experiment", "lexical")
        lab.run("alias/retry-storm.experiment.json", "linked")
        assertThat(runs.list().map { it.experiment }).containsOnly(experiment)
        val job = jobs.submit("alias/retry-storm.experiment.json")
        assertThat(jobs.list().single().experiment).isEqualTo(experiment)
        for (id in listOf("lexical", "linked")) {
            assertThat(
                mvc
                    .perform(delete("/api/v1/runs/{id}", id))
                    .andReturn()
                    .response.status,
            ).isEqualTo(409)
        }
        val response =
            mvc
                .perform(
                    delete("/api/v1/workspace/document")
                        .param("path", experiment)
                        .header("If-Match", "\"${workspace.read(experiment).version}\""),
                ).andReturn()
                .response
        assertThat(response.status).isEqualTo(409)
        assertThat(root.resolve(experiment)).exists()
        pending.single().run()
        assertThat(jobs.get(job.id)?.status).isEqualTo(JobStatus.COMPLETED)
        assertThat(runs.entry(job.runId)?.experiment).isEqualTo(experiment)
    }

    @Test
    fun `running cancellation keeps the artifact protected until its writes stop`() {
        val writing = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val blockingWorkspace =
            object : resiliencelab.core.workspace.Workspace by workspace {
                override fun createBytes(
                    path: String,
                    bytes: ByteArray,
                ): String {
                    writing.countDown()
                    check(release.await(30, java.util.concurrent.TimeUnit.SECONDS))
                    return workspace.createBytes(path, bytes)
                }
            }
        val runningLab = Lab(blockingWorkspace)
        val executor =
            java.util.concurrent.Executors
                .newSingleThreadExecutor()
        val runningJobs = JobService(runningLab, executor) { "writing-run" }
        val runningMvc =
            MockMvcBuilders
                .standaloneSetup(RunController(runs, runningJobs))
                .setControllerAdvice(LabExceptionHandler())
                .setMessageConverters(KotlinSerializationJsonHttpMessageConverter(Json { encodeDefaults = true }))
                .build()
        try {
            val job = runningJobs.submit(experiment)
            assertThat(writing.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue()
            runningJobs.cancel(job.id)
            assertThat(
                runningMvc
                    .perform(delete("/api/v1/runs/writing-run"))
                    .andReturn()
                    .response.status,
            ).isEqualTo(409)
            assertThat(
                runningMvc
                    .perform(get("/api/v1/runs/obsolete"))
                    .andReturn()
                    .response.contentAsString,
            ).doesNotContain("writing-run")
            release.countDown()
            executor.shutdown()
            assertThat(executor.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue()
            assertThat(runningJobs.get(job.id)?.status).isEqualTo(JobStatus.CANCELLED)
            assertThat(
                runningMvc
                    .perform(delete("/api/v1/runs/writing-run"))
                    .andReturn()
                    .response.status,
            ).isEqualTo(204)
        } finally {
            release.countDown()
            runningJobs.close()
            executor.close()
            runningLab.close()
        }
    }

    @Test
    fun `queued resume keeps the artifact until cancellation`() {
        val cancelled = AtomicBoolean()
        assertThatThrownBy {
            lab.run(experiment, "resume-me", isCancelled = cancelled::get) { done, _ ->
                if (done == 1) cancelled.set(true)
            }
        }.isInstanceOf(CancellationException::class.java)
        val job = jobs.resume(runs.entry("resume-me")!!)
        assertThatThrownBy { jobs.resume(runs.entry("resume-me")!!) }.isInstanceOf(Conflict::class.java)
        val blocked = mvc.perform(delete("/api/v1/runs/resume-me")).andReturn().response
        assertThat(blocked.status).isEqualTo(409)
        assertThat(
            root.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/resume-me/manifest.json"),
        ).exists()
        jobs.cancel(job.id)
        assertThat(
            mvc
                .perform(delete("/api/v1/runs/resume-me"))
                .andReturn()
                .response.status,
        ).isEqualTo(204)
    }
}
