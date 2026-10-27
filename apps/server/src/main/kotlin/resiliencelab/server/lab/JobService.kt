package resiliencelab.server.lab

import org.slf4j.LoggerFactory
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import java.util.UUID
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
) {
    private val lock = Any()
    private val jobs = LinkedHashMap<String, JobView>()
    private val terminal = ArrayDeque<String>()

    init {
        require(maxTerminalJobs >= 1) { "maxTerminalJobs must be at least 1" }
    }

    /** Queues a run of [experiment]; throws [InvalidExperimentException] when the experiment has errors. */
    fun submit(experiment: String): JobView {
        val report = lab.validate(experiment)
        if (!report.valid) throw InvalidExperimentException(report.diagnostics)
        val job = JobView(UUID.randomUUID().toString(), experiment, newRunId(), JobStatus.QUEUED, 0, 0)
        synchronized(lock) { jobs[job.id] = job }
        try {
            executor.execute { execute(job.id, report.documentVersions) }
        } catch (exception: RejectedExecutionException) {
            finish(job.id) { it.copy(status = JobStatus.FAILED, error = "Job queue is full") }
        }
        return get(job.id) ?: job
    }

    fun get(id: String): JobView? = synchronized(lock) { jobs[id] }

    /** Jobs, newest first. */
    fun list(): List<JobView> = synchronized(lock) { jobs.values.reversed() }

    private fun execute(
        id: String,
        expectedVersions: Map<String, String>,
    ) {
        val job = update(id) { it.copy(status = JobStatus.RUNNING) } ?: return
        try {
            lab.run(job.experiment, job.runId, expectedVersions) { completed, total ->
                update(id) { it.copy(completedTasks = maxOf(it.completedTasks, completed), totalTasks = total) }
            }
            finish(id) { it.copy(status = JobStatus.COMPLETED) }
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
            update(id, change) ?: return
            terminal.addLast(id)
            while (terminal.size > maxTerminalJobs) jobs.remove(terminal.removeFirst())
        }
    }

    private companion object {
        val logger = LoggerFactory.getLogger(JobService::class.java)
    }
}
