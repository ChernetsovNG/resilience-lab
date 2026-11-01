package resiliencelab.core.execution

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
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
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.results.ConnectionWindow
import resiliencelab.core.results.NodeWindow
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Results of one variant, in grid point order. */
data class VariantRun(
    val id: String,
    val label: String,
    val points: List<PointRun>,
)

/** Replications and aggregate for one effective model. */
data class PointRun(
    val id: String,
    val coordinates: Map<String, JsonElement>,
    val replications: List<ReplicationResult>,
    val aggregate: AggregateMetrics,
)

/** Result of all tasks of an experiment, in variant order. */
data class ExperimentRun(
    val variants: List<VariantRun>,
)

/**
 * Runs every (variant, point, replication) task in a fresh KSL model with path-based streams (ADR 0006). All runs of one
 * executor share its [workers] threads, taking tasks round robin between active jobs (ADR 0009). The stream
 * plan of all tasks is checked for collisions before any model runs, so results do not depend on the number of workers
 * or on the order of task completion. Worker threads are daemons; [close] stops them.
 */
class ExperimentExecutor internal constructor(
    private val workers: Int,
    private val replicate: ((GraphIr, StreamPlan, Long, Int) -> ReplicationResult)?,
) : AutoCloseable {
    constructor(workers: Int = defaultWorkers()) : this(workers, null)

    init {
        require(workers >= 1) { "workers must be at least 1" }
    }

    private val scheduler = RoundRobinScheduler(workers)

    /**
     * Runs tasks in variant/point/replication order within this job. [isCancelled] must be fast and thread-safe;
     * it is checked before tasks start and at most every 25 ms while the caller waits. Cancellation interrupts
     * this job's active workers; KSL models stop at the next event boundary. Other jobs keep their turns.
     * Initial progress runs on the caller before scheduling tasks; later callbacks run on workers.
     * Progress callbacks must return promptly or honor interruptions when blocking.
     * @throws CancellationException if cancellation is observed or the calling thread is interrupted.
     */
    fun run(
        experiment: CompiledExperiment,
        isCancelled: () -> Boolean = { false },
        onWindow: (
            variant: String,
            point: String,
            replication: Int,
            window: Int,
            rows: List<NodeWindow>,
            connections: List<ConnectionWindow>,
        ) -> Unit = { _, _, _, _, _, _ -> },
        onReplication: (variant: String, point: String, replication: Int, result: ReplicationResult) -> Unit = { _, _, _, _ -> },
        onOriginalCompletion: ((variant: String, point: String, replication: Int, latencyMs: Double, succeeded: Boolean) -> Unit)? = null,
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): ExperimentRun {
        val results =
            execute(
                experiment = experiment,
                selectedTasks = null,
                isCancelled = isCancelled,
                onWindow = onWindow,
                onReplication = onReplication,
                onOriginalCompletion = onOriginalCompletion,
                onProgress = onProgress,
            )
        return ExperimentRun(
            experiment.variants.mapIndexed { index, variant ->
                VariantRun(
                    variant.id,
                    variant.label,
                    variant.points.mapIndexed { pointIndex, point ->
                        val pointReplications = results[index][pointIndex].map { requireNotNull(it) }
                        PointRun(point.id, point.coordinates, pointReplications, MetricsAggregator.aggregate(pointReplications))
                    },
                )
            },
        ).also { checkCancellation(isCancelled) }
    }

    /** Runs only invalid tasks during resume, retaining their original replication numbers and progress total. */
    internal fun runSelected(
        experiment: CompiledExperiment,
        tasks: Collection<ExperimentTask>,
        isCancelled: () -> Boolean = { false },
        onWindow: (
            variant: String,
            point: String,
            replication: Int,
            window: Int,
            rows: List<NodeWindow>,
            connections: List<ConnectionWindow>,
        ) -> Unit = { _, _, _, _, _, _ -> },
        onReplication: (variant: String, point: String, replication: Int, result: ReplicationResult) -> Unit = { _, _, _, _ -> },
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ) {
        execute(experiment, tasks, isCancelled, onWindow, onReplication, null, onProgress)
        checkCancellation(isCancelled)
    }

    private fun execute(
        experiment: CompiledExperiment,
        selectedTasks: Collection<ExperimentTask>?,
        isCancelled: () -> Boolean,
        onWindow: (
            variant: String,
            point: String,
            replication: Int,
            window: Int,
            rows: List<NodeWindow>,
            connections: List<ConnectionWindow>,
        ) -> Unit,
        onReplication: (variant: String, point: String, replication: Int, result: ReplicationResult) -> Unit,
        onOriginalCompletion: ((variant: String, point: String, replication: Int, latencyMs: Double, succeeded: Boolean) -> Unit)?,
        onProgress: (completed: Int, total: Int) -> Unit,
    ): List<List<Array<ReplicationResult?>>> {
        checkCancellation(isCancelled)
        val replications = experiment.run.replications
        val plan =
            StreamPlan(
                experiment.variants.flatMap { variant ->
                    variant.points.flatMap { point -> (0 until replications).flatMap { PathStreams.keys(point.graph, it) } }
                },
            )
        val allTasks =
            experiment
                .variants
                .indices
                .flatMap { variant ->
                    experiment.variants[variant].points.indices.flatMap { point ->
                        (0 until replications).map { Triple(variant, point, it) }
                    }
                }
        val tasks =
            allTasks.filter { (variant, point, replication) ->
                selectedTasks == null ||
                    ExperimentTask(
                        experiment.variants[variant].id,
                        experiment.variants[variant].points[point].id,
                        replication,
                    ) in selectedTasks
            }
        val results = experiment.variants.map { variant -> variant.points.map { arrayOfNulls<ReplicationResult>(replications) } }
        val progress = Progress(allTasks.size, allTasks.size - tasks.size, onProgress)
        scheduler.run(
            tasks.map { (variant, point, replication) ->
                {
                    checkCancellation(isCancelled)
                    val compiledVariant = experiment.variants[variant]
                    val compiledPoint = compiledVariant.points[point]
                    val result =
                        try {
                            replicate?.invoke(compiledPoint.graph, plan, experiment.run.seed, replication)
                                ?: runReplication(
                                    compiledPoint.graph,
                                    plan,
                                    experiment.run.seed,
                                    replication,
                                    onWindow = {
                                        window,
                                        rows,
                                        connections,
                                        ->
                                        onWindow(compiledVariant.id, compiledPoint.id, replication, window, rows, connections)
                                    },
                                    onOriginalCompletion =
                                        onOriginalCompletion?.let { observer ->
                                            {
                                                latency,
                                                succeeded,
                                                ->
                                                observer(
                                                    compiledVariant.id,
                                                    compiledPoint.id,
                                                    replication,
                                                    latency,
                                                    succeeded,
                                                )
                                            }
                                        },
                                )
                        } catch (failure: ExperimentExecutionException) {
                            val id = experiment.variants[variant].id
                            val message = "Variant '$id', point '${compiledPoint.id}', replication ${replication + 1}: ${failure.message}"
                            throw ExperimentExecutionException(
                                message,
                                failure,
                                failure.diagnostic?.let { diagnostic ->
                                    diagnostic.copy(
                                        message = message,
                                        variant = id,
                                        args =
                                            diagnostic.args.orEmpty() +
                                                mapOf(
                                                    "variant" to JsonPrimitive(id),
                                                    "point" to JsonPrimitive(compiledPoint.id),
                                                    "replication" to JsonPrimitive(replication + 1),
                                                ),
                                    )
                                },
                            )
                        }
                    checkCancellation(isCancelled)
                    onReplication(compiledVariant.id, compiledPoint.id, replication, result)
                    checkCancellation(isCancelled)
                    synchronized(results) { results[variant][point][replication] = result }
                    progress.completeOne()
                }
            },
            isCancelled,
        )
        return results
    }

    /** Runs independent finalization work in the shared fair pool, returning values in input order. */
    internal fun <T, R : Any> mapOrdered(
        items: List<T>,
        transform: (T) -> R,
    ): List<R> {
        val results = MutableList<R?>(items.size) { null }
        scheduler.run(items.mapIndexed { index, item -> { results[index] = transform(item) } }, { false })
        return results.map { requireNotNull(it) }
    }

    internal val isClosed: Boolean get() = scheduler.isClosed

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
        val drained = CompletableFuture<Unit>()
        var running = 0
        val threads = mutableSetOf<Thread>()
    }

    private val pool: ExecutorService =
        Executors.newFixedThreadPool(workers) { task -> Thread(task, "experiment-task").apply { isDaemon = true } }
    private val lock = Any()
    private val ready = ArrayDeque<Job>()
    private val jobs = mutableSetOf<Job>()
    private var active = 0
    private var closed = false
    val isClosed: Boolean get() = synchronized(lock) { closed }

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
            // Workers finish their current artifact writes before a final incomplete manifest can be published.
            job.drained.join()
        }
    }

    /** Called with [lock] held; rotates jobs in submission order and issues at most [workers] tasks. */
    private fun dispatch() {
        while (!closed && active < workers && ready.isNotEmpty()) {
            val job = ready.removeFirst()
            val task = job.pending.next()
            if (job.pending.hasNext()) ready.addLast(job)
            active++
            job.running++
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
                job.running--
                if (job.finished.isDone && job.running == 0) job.drained.complete(Unit)
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
        if (job.running == 0) job.drained.complete(Unit)
    }

    override fun close() {
        synchronized(lock) {
            closed = true
            jobs.toList().forEach { finish(it, CancellationException("Experiment executor was closed")) }
        }
        // Issued tasks still queued must enter perform() and release their drain accounting.
        pool.shutdown()
    }
}

/** A caller interruption and an explicit cancellation signal have the same job-level outcome. */
internal fun checkCancellation(isCancelled: () -> Boolean) {
    if (Thread.currentThread().isInterrupted || isCancelled()) throw CancellationException("Experiment was cancelled")
}

/** Finished tasks of one run; the count and its notification change together, so reported counts only grow. */
private class Progress(
    private val total: Int,
    private var completed: Int,
    private val onProgress: (Int, Int) -> Unit,
) {
    init {
        onProgress(completed, total)
    }

    @Synchronized
    fun completeOne() {
        completed += 1
        onProgress(completed, total)
    }
}

/** One task: a fresh KSL model, one replication, streams of this replication only. */
private fun runReplication(
    graph: GraphIr,
    plan: StreamPlan,
    seed: Long,
    replication: Int,
    onWindow: (Int, List<NodeWindow>, List<ConnectionWindow>) -> Unit,
    onOriginalCompletion: ((Double, Boolean) -> Unit)?,
): ReplicationResult {
    val model = Model("resilience-lab-task", autoCSVReports = false)
    return ReliabilityModel(
        model,
        graph,
        PathStreamSource(plan, seed, replication.toLong()),
        onWindow = onWindow,
        onOriginalCompletion = onOriginalCompletion,
    ).runReplication()
}
