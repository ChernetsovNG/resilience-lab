package resiliencelab.core.execution

import ksl.simulation.Model
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.engine.ksl.ExperimentExecutionException
import resiliencelab.core.engine.ksl.PathStreamSource
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.ReliabilityModel
import resiliencelab.core.engine.ksl.StreamPlan
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.MetricsAggregator
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.ChainIr
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Replications of one variant and their aggregate. */
data class VariantRun(
    val id: String,
    val label: String,
    val replications: List<ReplicationResult>,
    val aggregate: AggregateMetrics,
)

/** Result of all tasks of an experiment, in variant order. */
data class ExperimentRun(
    val variants: List<VariantRun>,
)

/**
 * Runs every (variant, replication) task in a fresh KSL model with path-based streams (ADR 0006). All runs of one
 * executor share its [workers] threads, taking tasks round robin between active jobs (ADR 0009). The stream
 * plan of all tasks is checked for collisions before any model runs, so results do not depend on the number of workers
 * or on the order of task completion. Worker threads are daemons; [close] stops them.
 */
class ExperimentExecutor internal constructor(
    private val workers: Int,
    private val replicate: (ChainIr, StreamPlan, Long, Int) -> ReplicationResult,
) : AutoCloseable {
    constructor(workers: Int = defaultWorkers()) : this(workers, ::runReplication)

    init {
        require(workers >= 1) { "workers must be at least 1" }
    }

    private val scheduler = RoundRobinScheduler(workers)

    /**
     * Runs tasks in variant/replication order within this job. [isCancelled] must be fast and thread-safe;
     * it is checked before tasks start and at most every 25 ms while the caller waits. Cancellation interrupts
     * this job's active workers; KSL models stop at the next event boundary. Other jobs keep their turns.
     * @throws CancellationException if cancellation is observed or the calling thread is interrupted.
     */
    fun run(
        experiment: CompiledExperiment,
        isCancelled: () -> Boolean = { false },
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): ExperimentRun {
        checkCancellation(isCancelled)
        val replications = experiment.run.replications
        val plan =
            StreamPlan(
                experiment.variants.flatMap { variant -> (0 until replications).flatMap { PathStreams.keys(variant.chain, it) } },
            )
        val tasks = experiment.variants.indices.flatMap { variant -> (0 until replications).map { variant to it } }
        val results = Array(experiment.variants.size) { arrayOfNulls<ReplicationResult>(replications) }
        val progress = Progress(tasks.size, onProgress)
        scheduler.run(
            tasks.map { (variant, replication) ->
                {
                    checkCancellation(isCancelled)
                    val result =
                        try {
                            replicate(experiment.variants[variant].chain, plan, experiment.run.seed, replication)
                        } catch (failure: ExperimentExecutionException) {
                            val id = experiment.variants[variant].id
                            val message = "Variant '$id', replication ${replication + 1}: ${failure.message}"
                            throw ExperimentExecutionException(message, failure)
                        }
                    checkCancellation(isCancelled)
                    synchronized(results) { results[variant][replication] = result }
                    progress.completeOne()
                }
            },
            isCancelled,
        )
        return ExperimentRun(
            experiment.variants.mapIndexed { index, variant ->
                val variantReplications = results[index].map { requireNotNull(it) }
                VariantRun(variant.id, variant.label, variantReplications, MetricsAggregator.aggregate(variantReplications))
            },
        ).also { checkCancellation(isCancelled) }
    }

    /** Stops the worker threads; tasks still running are interrupted. */
    override fun close() {
        scheduler.close()
    }

    companion object {
        /** All cores but one, so the server stays responsive (ADR 0009). */
        fun defaultWorkers(): Int = maxOf(1, Runtime.getRuntime().availableProcessors() - 1)
    }
}

/** Only dispatched tasks enter the pool, so its FIFO queue cannot put a whole job ahead of later jobs. */
private class RoundRobinScheduler(
    private val workers: Int,
) : AutoCloseable {
    private class Job(
        tasks: List<() -> Unit>,
    ) {
        val pending = tasks.iterator()
        var remaining = tasks.size
        val finished = CompletableFuture<Unit>()
        val threads = mutableSetOf<Thread>()
    }

    private val pool: ExecutorService =
        Executors.newFixedThreadPool(workers) { task -> Thread(task, "experiment-task").apply { isDaemon = true } }
    private val lock = Any()
    private val ready = ArrayDeque<Job>()
    private val jobs = mutableSetOf<Job>()
    private var active = 0
    private var closed = false

    fun run(
        tasks: List<() -> Unit>,
        isCancelled: () -> Boolean,
    ) {
        val job = Job(tasks)
        synchronized(lock) {
            if (closed) throw RejectedExecutionException("Experiment executor is closed")
            if (tasks.isEmpty()) return
            jobs += job
            ready.addLast(job)
            dispatch()
        }
        try {
            while (true) {
                checkCancellation(isCancelled)
                try {
                    job.finished.get(25, TimeUnit.MILLISECONDS)
                    return
                } catch (_: TimeoutException) {
                    // Poll cancellation even when all workers are occupied by other jobs.
                }
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            throw CancellationException("Experiment was cancelled")
        } catch (exception: ExecutionException) {
            throw exception.cause ?: exception
        } finally {
            synchronized(lock) { finish(job, CancellationException("Experiment was cancelled")) }
        }
    }

    /** Called with [lock] held; rotates jobs in submission order and issues at most [workers] tasks. */
    private fun dispatch() {
        while (!closed && active < workers && ready.isNotEmpty()) {
            val job = ready.removeFirst()
            val task = job.pending.next()
            if (job.pending.hasNext()) ready.addLast(job)
            active++
            pool.execute { perform(job, task) }
        }
    }

    private fun perform(
        job: Job,
        task: () -> Unit,
    ) {
        val worker = Thread.currentThread()
        try {
            synchronized(lock) {
                if (job.finished.isDone) return
                job.threads += worker
            }
            task()
            synchronized(lock) {
                job.remaining--
                if (job.remaining == 0) finish(job)
            }
        } catch (failure: Throwable) {
            synchronized(lock) { finish(job, failure) }
        } finally {
            synchronized(lock) {
                job.threads -= worker
                active--
                Thread.interrupted()
                dispatch()
            }
        }
    }

    /** Completes a job once, removing unissued tasks and interrupting its active tasks on failure. */
    private fun finish(
        job: Job,
        failure: Throwable? = null,
    ) {
        if (job.finished.isDone) return
        ready.remove(job)
        jobs -= job
        if (failure == null) {
            job.finished.complete(Unit)
        } else {
            job.finished.completeExceptionally(failure)
            job.threads.forEach { it.interrupt() }
        }
    }

    override fun close() {
        synchronized(lock) {
            closed = true
            jobs.toList().forEach { finish(it, CancellationException("Experiment executor was closed")) }
        }
        pool.shutdownNow()
    }
}

/** A caller interruption and an explicit cancellation signal have the same job-level outcome. */
internal fun checkCancellation(isCancelled: () -> Boolean) {
    if (Thread.currentThread().isInterrupted || isCancelled()) throw CancellationException("Experiment was cancelled")
}

/** Finished tasks of one run; the count and its notification change together, so reported counts only grow. */
private class Progress(
    private val total: Int,
    private val onProgress: (Int, Int) -> Unit,
) {
    private var completed = 0

    @Synchronized
    fun completeOne() {
        completed += 1
        onProgress(completed, total)
    }
}

/** One task: a fresh KSL model, one replication, streams of this replication only. */
private fun runReplication(
    chain: ChainIr,
    plan: StreamPlan,
    seed: Long,
    replication: Int,
): ReplicationResult {
    val model = Model("resilience-lab-task", autoCSVReports = false)
    return ReliabilityModel(model, chain, PathStreamSource(plan, seed, replication.toLong())).runReplication()
}
