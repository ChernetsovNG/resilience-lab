package resiliencelab.server.experiment

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
import resiliencelab.core.scenario.ExperimentDocument
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/** Stores bounded process-local job snapshots and executes submitted experiments on a bounded executor. */
@Service
class ExperimentJobManager(
    @Qualifier("simulationExecutor") private val executor: Executor,
    private val experimentExecutor: ExperimentExecutor,
) {
    private val jobs = ConcurrentHashMap<UUID, ExperimentJob>()
    private val terminalJobs = ArrayDeque<UUID>()
    private val retentionLock = Any()

    /** Queues [document] and returns its identifier without waiting for execution to finish. */
    fun submit(document: ExperimentDocument): UUID {
        val id = UUID.randomUUID()
        jobs[id] = ExperimentJob(id, ExperimentJobStatus.QUEUED, result = null, error = null)
        try {
            executor.execute { execute(id, document) }
        } catch (exception: RejectedExecutionException) {
            logger.error("Experiment job {} was rejected", id, exception)
            val error = "Experiment execution failed"
            transition(id) {
                it.copy(status = ExperimentJobStatus.FAILED, result = null, error = error)
            }
        }
        return id
    }

    /** Returns the latest immutable snapshot for [id], or null when the job is unknown or evicted. */
    fun get(id: UUID): ExperimentJob? = jobs[id]

    private fun execute(
        id: UUID,
        document: ExperimentDocument,
    ) {
        transition(id) { it.copy(status = ExperimentJobStatus.RUNNING) }
        try {
            val result = experimentExecutor.execute(document)
            transition(id) {
                it.copy(status = ExperimentJobStatus.COMPLETED, result = result, error = null)
            }
        } catch (exception: Exception) {
            logger.error("Experiment job {} failed", id, exception)
            val error = "Experiment execution failed"
            transition(id) {
                it.copy(status = ExperimentJobStatus.FAILED, result = null, error = error)
            }
        }
    }

    private fun transition(
        id: UUID,
        update: (ExperimentJob) -> ExperimentJob,
    ) {
        synchronized(retentionLock) {
            val job = jobs[id] ?: return
            val updated = update(job)
            jobs[id] = updated
            if (!job.status.isTerminal() && updated.status.isTerminal()) {
                terminalJobs.addLast(id)
                while (terminalJobs.size > MAX_TERMINAL_JOBS) {
                    jobs.remove(terminalJobs.removeFirst())
                }
            }
        }
    }

    private fun ExperimentJobStatus.isTerminal(): Boolean = this == ExperimentJobStatus.COMPLETED || this == ExperimentJobStatus.FAILED

    private companion object {
        const val MAX_TERMINAL_JOBS = 100
        val logger = LoggerFactory.getLogger(ExperimentJobManager::class.java)
    }
}
