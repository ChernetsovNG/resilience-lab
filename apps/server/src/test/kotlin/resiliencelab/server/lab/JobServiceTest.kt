package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.util.concurrent.CancellationException
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

class JobServiceTest {
    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val root = TestWorkspace.copy()
    private val lab = Lab(FileWorkspace(root), executor = ExperimentExecutor(workers = 2))
    private var runs = 0

    private fun service(
        executor: Executor = Executor { it.run() },
        maxTerminalJobs: Int = 100,
    ) = JobService(lab, executor, maxTerminalJobs) { "run-${++runs}" }

    @Test
    fun `runs a job to completion and records progress`() {
        val job = service().submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.COMPLETED)
        assertThat(job.runId).isEqualTo("run-1")
        assertThat(job.completedTasks).isEqualTo(20)
        assertThat(job.totalTasks).isEqualTo(20)
        assertThat(root.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-1/manifest.json")).exists()
    }

    @Test
    fun `runs an experiment whose directory and filename contain Cyrillic and spaces`() {
        val directory = root.resolve("Платёжный контур")
        Files.move(root.resolve("retry-storm"), directory)
        Files.move(directory.resolve("retry-storm.experiment.json"), directory.resolve("Платёжный контур.experiment.json"))
        val path = "Платёжный контур/Платёжный контур.experiment.json"

        val job = service().submit(path)

        assertThat(job.status).isEqualTo(JobStatus.COMPLETED)
        val run = RunCatalog(FileWorkspace(root)).entry(job.runId)!!
        assertThat(run.experiment).isEqualTo(path)
        assertThat(run.directory).matches("\\.results/[a-f0-9]{64}/run-1")
        assertThat(root.resolve(run.directory).resolve("manifest.json")).exists()
    }

    @Test
    fun `invalid run identifier reports a structured known cause`() {
        val job = JobService(lab, Executor { it.run() }) { "../invalid" }.submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        val diagnostic = job.diagnostics.single()
        assertThat(diagnostic.code).isEqualTo("RUN_ID")
        assertThat(diagnostic.args).containsEntry("id", JsonPrimitive("../invalid"))
        assertThat(root.resolve(".results")).doesNotExist()
    }

    @Test
    fun `rejects an invalid experiment before queueing`() {
        assertThatThrownBy { service().submit("missing.experiment.json") }
            .isInstanceOf(InvalidExperimentException::class.java)
    }

    @Test
    fun `reports an experiment that became invalid before its job ran`() {
        val queued = mutableListOf<Runnable>()
        val jobs = service(Executor { queued += it })
        val job = jobs.submit(experiment)
        assertThat(job.status).isEqualTo(JobStatus.QUEUED)

        Files.writeString(root.resolve("retry-storm/retry-storm.model.json"), "{")
        queued.single().run()

        val failed = jobs.get(job.id)!!
        assertThat(failed.status).isEqualTo(JobStatus.FAILED)
        assertThat(failed.error).isEqualTo("Experiment has errors")
        val body = Json.parseToJsonElement(Json.encodeToString(JobView.serializer(), failed)).jsonObject
        assertThat(body["errorCode"]).isEqualTo(JsonPrimitive("EXPERIMENT_INVALID"))
        assertThat(body["errorArgs"]).isEqualTo(Json.parseToJsonElement("{}"))
        assertThat(failed.diagnostics.single().code).isEqualTo("JSON_SYNTAX")
    }

    @Test
    fun `reports execution failures without details`() {
        Files.writeString(root.resolve(".results"), "not a directory")

        val job = service().submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        assertThat(job.error).isEqualTo("Experiment execution failed")
        val body = Json.parseToJsonElement(Json.encodeToString(JobView.serializer(), job)).jsonObject
        assertThat(body["errorCode"]).isEqualTo(JsonPrimitive("EXPERIMENT_EXECUTION_FAILED"))
        assertThat(body["errorArgs"]).isEqualTo(Json.parseToJsonElement("{}"))
        assertThat(job.diagnostics).isEmpty()
    }

    @Test
    fun `execution cap exposes its known cause and task arguments`() {
        val file = root.resolve(experiment)
        val original = Files.readString(file)
        val json = Json.parseToJsonElement(original).jsonObject.toMutableMap()
        val execution = json.getValue("execution").jsonObject.toMutableMap()
        execution["replications"] = JsonPrimitive(1)
        execution["warmup"] = JsonPrimitive("0ms")
        execution["measurement"] = JsonPrimitive("100s")
        execution["maxRealTime"] = JsonPrimitive("1s")
        json["execution"] = kotlinx.serialization.json.JsonObject(execution)
        Files.writeString(
            file,
            kotlinx.serialization.json
                .JsonObject(json)
                .toString(),
        )
        val model = root.resolve("retry-storm/retry-storm.model.json")
        Files.writeString(model, Files.readString(model).replace("120/s", "1000000/s"))

        val job = service().submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        assertThat(job.errorCode).isEqualTo("EXECUTION_REAL_TIME_LIMIT")
        assertThat(job.errorArgs).containsAllEntriesOf(
            mapOf("seconds" to JsonPrimitive(1), "point" to JsonPrimitive("p0"), "replication" to JsonPrimitive(1)),
        )
    }

    @Test
    fun `reports a full queue`() {
        val job = service(Executor { throw RejectedExecutionException() }).submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        assertThat(job.error).isEqualTo("Job queue is full")
        val body = Json.parseToJsonElement(Json.encodeToString(JobView.serializer(), job)).jsonObject
        assertThat(body["errorCode"]).isEqualTo(JsonPrimitive("JOB_QUEUE_FULL"))
        assertThat(body["errorArgs"]).isEqualTo(Json.parseToJsonElement("{}"))
    }

    @Test
    fun `keeps the newest finished jobs and lists newest first`() {
        val jobs = service(maxTerminalJobs = 2)
        val first = jobs.submit(experiment)
        val second = jobs.submit(experiment)
        val third = jobs.submit(experiment)

        assertThat(jobs.get(first.id)).isNull()
        assertThat(jobs.list().map { it.id }).containsExactly(third.id, second.id)
    }

    @Test
    fun `keeps queued jobs and evicts by completion order`() {
        val queued = mutableListOf<Runnable>()
        val jobs = service(Executor { queued += it }, maxTerminalJobs = 1)
        val first = jobs.submit(experiment)
        val second = jobs.submit(experiment)
        val third = jobs.submit(experiment)

        queued[2].run()
        queued[1].run()

        assertThat(jobs.get(first.id)?.status).isEqualTo(JobStatus.QUEUED)
        assertThat(jobs.get(third.id)).isNull()
        assertThat(jobs.list().map { it.id }).containsExactly(second.id, first.id)
    }

    @Test
    fun `queued cancellation is immediate idempotent and never starts computing`() {
        val queued = mutableListOf<Runnable>()
        val jobs = service(Executor { queued += it }, maxTerminalJobs = 2)
        val job = jobs.submit(experiment)

        val cancelled = jobs.cancel(job.id)!!
        assertThat(cancelled.status).isEqualTo(JobStatus.CANCELLED)
        assertThat(cancelled.cancelRequested).isTrue()
        assertThat(cancelled.errorCode).isNull()
        assertThat(cancelled.errorArgs).isNull()
        assertThat(jobs.cancel(job.id)).isEqualTo(cancelled)
        queued.single().run()

        assertThat(jobs.get(job.id)).isEqualTo(cancelled)
        assertThat(root.resolve(".results")).doesNotExist()
        val next = jobs.submit(experiment)
        queued.last().run()
        assertThat(jobs.get(next.id)?.status).isEqualTo(JobStatus.COMPLETED)
        assertThat(jobs.get(job.id)).isEqualTo(cancelled)
    }

    @Test
    fun `failed jobs cannot be cancelled`() {
        val jobs = service(Executor { throw RejectedExecutionException() })
        val failed = jobs.submit(experiment)

        assertThatThrownBy { jobs.cancel(failed.id) }
            .isInstanceOf(Conflict::class.java)
            .hasFieldOrPropertyWithValue("code", "JOB_FINISHED")
        assertThat(jobs.get(failed.id)).isEqualTo(failed)
    }

    @Test
    fun `shutdown cancels queued and late jobs while preserving finished jobs`() {
        val queued = mutableListOf<Runnable>()
        val jobs = service(Executor { queued += it })
        val finished = jobs.submit(experiment)
        queued.single().run()
        val first = jobs.submit(experiment)
        val second = jobs.submit(experiment)

        jobs.close()
        jobs.close()

        listOf(first, second).forEach { job ->
            assertThat(jobs.get(job.id)?.status).isEqualTo(JobStatus.CANCELLED)
            assertThat(jobs.get(job.id)?.cancelRequested).isTrue()
        }
        assertThat(jobs.get(finished.id)?.status).isEqualTo(JobStatus.COMPLETED)
        assertThat(jobs.get(finished.id)?.cancelRequested).isFalse()
        val late = jobs.submit(experiment)
        assertThat(late.status).isEqualTo(JobStatus.CANCELLED)
        assertThat(late.cancelRequested).isTrue()
        assertThat(queued).hasSize(3)
        queued.drop(1).forEach { it.run() }
        listOf(first, second, late).forEach { job ->
            assertThat(
                root.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/${job.runId}"),
            ).doesNotExist()
        }
    }

    @Test
    fun `rejects valid document changes made while a job is queued`() {
        val queued = mutableListOf<Runnable>()
        val jobs = service(Executor { queued += it })
        val job = jobs.submit(experiment)
        val file = root.resolve(experiment)
        val original = Files.readString(file)
        val changed = original.replace("20261025", "20261026")
        assertThat(changed).isNotEqualTo(original)
        Files.writeString(file, changed)

        queued.single().run()

        val failed = jobs.get(job.id)!!
        assertThat(failed.status).isEqualTo(JobStatus.FAILED)
        assertThat(failed.diagnostics.single().code).isEqualTo("DOCUMENT_CHANGED")
        assertThat(root.resolve(".results")).doesNotExist()
    }

    @Test
    fun `resume rechecks documents after preflight before queued execution`() {
        val cancelled = AtomicBoolean()
        assertThatThrownBy {
            lab.run(experiment, "cancelled", isCancelled = cancelled::get) { done, _ ->
                if (done == 1) cancelled.set(true)
            }
        }.isInstanceOf(CancellationException::class.java)
        val runDirectory = ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/cancelled"
        val entry = RunCatalog(FileWorkspace(root)).entry("cancelled")!!
        val before = artifactHashes(runDirectory)
        val queued = mutableListOf<Runnable>()
        val jobs = service(Executor { queued += it })
        val job = jobs.resume(entry)
        assertThat(job.status).isEqualTo(JobStatus.QUEUED)
        val model = root.resolve("retry-storm/retry-storm.model.json")
        Files.writeString(model, Files.readString(model).replace("\"handlers\": 4", "\"handlers\": 5"))

        queued.single().run()

        val failed = jobs.get(job.id)!!
        assertThat(failed.status).isEqualTo(JobStatus.FAILED)
        assertThat(failed.diagnostics.single().code).isEqualTo("RUN_DOCUMENT_CHANGED")
        assertThat(artifactHashes(runDirectory)).isEqualTo(before)
    }

    private fun artifactHashes(runDirectory: String): Map<String, String> =
        FileWorkspace(root).listFiles(runDirectory).associateWith { path ->
            DocumentVersion.of(Files.readAllBytes(root.resolve(path)))
        }
}
