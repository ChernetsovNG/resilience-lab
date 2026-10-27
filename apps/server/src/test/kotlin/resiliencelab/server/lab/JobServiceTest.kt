package resiliencelab.server.lab

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

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
        assertThat(job.completedTasks).isEqualTo(4)
        assertThat(job.totalTasks).isEqualTo(4)
        assertThat(root.resolve(".results/retry-storm/run-1/manifest.json")).exists()
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
        assertThat(failed.diagnostics.single().code).isEqualTo("JSON_SYNTAX")
    }

    @Test
    fun `reports execution failures without details`() {
        Files.writeString(root.resolve(".results"), "not a directory")

        val job = service().submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        assertThat(job.error).isEqualTo("Experiment execution failed")
        assertThat(job.diagnostics).isEmpty()
    }

    @Test
    fun `reports a full queue`() {
        val job = service(Executor { throw RejectedExecutionException() }).submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        assertThat(job.error).isEqualTo("Job queue is full")
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
}
