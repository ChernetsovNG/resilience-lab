package resiliencelab.server.lab

import org.slf4j.LoggerFactory
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.results.RunEntry
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * Process-local jobs (ADR 0009, stage 1 slice): a job validates its experiment on submission and then runs it through
 * [Lab] on [executor]. At most [maxTerminalJobs] finished jobs are kept, oldest evicted first; active jobs stay.
 * Accepted computation-input versions are checked by the core before a queued job starts computing.
 */
class JobService(
    private val lab: Lab,
    private val executor: Executor,
    private val maxTerminalJobs: Int = 100,
    private val newRunId: () -> String,
) : AutoCloseable {
    private val lock = Any()
    private val jobs = LinkedHashMap<String, JobView>()
    private val terminal = ArrayDeque<String>()
    private var stopping = false

    init {
        require(maxTerminalJobs >= 1) { "maxTerminalJobs must be at least 1" }
    }

    /** Queues a run of [experiment]; throws [InvalidExperimentException] when the experiment has errors. */
    fun submit(experiment: String): JobView {
        val report = lab.validate(experiment)
        if (!report.valid) throw InvalidExperimentException(report.diagnostics)
        val job = JobView(UUID.randomUUID().toString(), experiment, newRunId(), JobStatus.QUEUED, 0, 0)
        synchronized(lock) {
            jobs[job.id] = job
            if (stopping) return cancel(job.id)!!
        }
        try {
            executor.execute { execute(job.id, report.documentVersions) }
        } catch (exception: RejectedExecutionException) {
            finish(job.id) { it.copy(status = JobStatus.FAILED, error = "Job queue is full") }
        }
        return get(job.id) ?: job
    }

    /** Validates and queues an in-place resume of [run]; execution repeats every core check. */
    fun resume(run: RunEntry): JobView {
        try {
            lab.validateResume(run.directory)
        } catch (exception: InvalidExperimentException) {
            if (exception.diagnostics.any { it.code == "RUN_COMPLETE" }) {
                throw Conflict("RUN_COMPLETE", "Run '${run.id}' is already complete", exception.diagnostics)
            }
            throw exception
        }
        val job = JobView(UUID.randomUUID().toString(), run.experiment, run.id, JobStatus.QUEUED, 0, 0)
        synchronized(lock) {
            jobs[job.id] = job
            if (stopping) return cancel(job.id)!!
        }
        try {
            executor.execute { executeResume(job.id, run.directory) }
        } catch (exception: RejectedExecutionException) {
            finish(job.id) { it.copy(status = JobStatus.FAILED, error = "Job queue is full") }
        }
        return get(job.id) ?: job
    }

    private fun executeResume(
        id: String,
        runDirectory: String,
    ) {
        synchronized(lock) {
            jobs[id]
                ?.takeIf { it.status == JobStatus.QUEUED }
                ?.copy(status = JobStatus.RUNNING)
                ?.also { jobs[id] = it }
        } ?: return
        try {
            lab.resume(runDirectory, isCancelled = { get(id)?.cancelRequested != false }) { completed, total ->
                update(id) { it.copy(completedTasks = maxOf(it.completedTasks, completed), totalTasks = total) }
            }
            finish(id) { it.copy(status = JobStatus.COMPLETED) }
        } catch (exception: CancellationException) {
            finish(id) { it.copy(status = JobStatus.CANCELLED) }
        } catch (exception: InvalidExperimentException) {
            finish(id) { it.copy(status = JobStatus.FAILED, error = "Experiment has errors", diagnostics = exception.diagnostics) }
        } catch (exception: Exception) {
            logger.error("Resume job {} failed", id, exception)
            finish(id) { it.copy(status = JobStatus.FAILED, error = "Experiment execution failed") }
        }
    }

    fun get(id: String): JobView? = synchronized(lock) { jobs[id] }

    /** Jobs, newest first. */
    fun list(): List<JobView> = synchronized(lock) { jobs.values.reversed() }

    /**
     * Cancels every active job before Spring closes the calling executor and then the core pool.
     * Submissions racing with shutdown are cancelled without being scheduled. The calling executor drains writes.
     */
    override fun close() {
        synchronized(lock) {
            stopping = true
            jobs.values
                .filter { it.status == JobStatus.QUEUED || it.status == JobStatus.RUNNING }
                .map { it.id }
                .forEach { cancel(it) }
        }
    }

    /**
     * Requests cooperative cancellation. Queued jobs stop immediately without creating an artifact; running jobs stay
     * running until [Lab] has stopped and finished its pending writes. Repeated cancellation is idempotent.
     * Returns `null` for an unknown job; completed and failed jobs throw [Conflict] with code `JOB_FINISHED`.
     */
    fun cancel(id: String): JobView? =
        synchronized(lock) {
            val job = jobs[id] ?: return null
            when (job.status) {
                JobStatus.CANCELLED -> job
                JobStatus.COMPLETED, JobStatus.FAILED -> throw Conflict("JOB_FINISHED", "Job '$id' has already finished")
                JobStatus.QUEUED -> {
                    val cancelled = job.copy(status = JobStatus.CANCELLED, cancelRequested = true)
                    finish(id) { cancelled }
                    cancelled
                }
                JobStatus.RUNNING -> job.copy(cancelRequested = true).also { jobs[id] = it }
            }
        }

    private fun execute(
        id: String,
        expectedVersions: Map<String, String>,
    ) {
        val job =
            synchronized(lock) {
                jobs[id]
                    ?.takeIf { it.status == JobStatus.QUEUED }
                    ?.copy(status = JobStatus.RUNNING)
                    ?.also { jobs[id] = it }
            } ?: return
        try {
            lab.run(job.experiment, job.runId, expectedVersions, isCancelled = { get(id)?.cancelRequested != false }) { completed, total ->
                update(id) { it.copy(completedTasks = maxOf(it.completedTasks, completed), totalTasks = total) }
            }
            finish(id) { it.copy(status = JobStatus.COMPLETED) }
        } catch (exception: CancellationException) {
            finish(id) { it.copy(status = JobStatus.CANCELLED) }
        } catch (exception: InvalidExperimentException) {
            finish(id) { it.copy(status = JobStatus.FAILED, error = "Experiment has errors", diagnostics = exception.diagnostics) }
        } catch (exception: Exception) {
            logger.error("Job {} failed", id, exception)
            finish(id) { it.copy(status = JobStatus.FAILED, error = "Experiment execution failed") }
        }
    }

    private fun update(
        id: String,
        change: (JobView) -> JobView,
    ): JobView? = synchronized(lock) { jobs[id]?.let(change)?.also { jobs[id] = it } }

    private fun finish(
        id: String,
        change: (JobView) -> JobView,
    ) {
        synchronized(lock) {
            val job = jobs[id] ?: return
            if (job.status == JobStatus.COMPLETED || job.status == JobStatus.FAILED || job.status == JobStatus.CANCELLED) return
            jobs[id] = change(job)
            terminal.addLast(id)
            while (terminal.size > maxTerminalJobs) jobs.remove(terminal.removeFirst())
        }
    }

    private companion object {
        val logger = LoggerFactory.getLogger(JobService::class.java)
    }
}
