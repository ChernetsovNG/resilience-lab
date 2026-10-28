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
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

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
 * executor share its [workers] threads (ADR 0009; interleaving tasks of different jobs is a later step). The stream
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

    private val pool: ExecutorService =
        Executors.newFixedThreadPool(workers) { task -> Thread(task, "experiment-task").apply { isDaemon = true } }

    fun run(
        experiment: CompiledExperiment,
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): ExperimentRun {
        val replications = experiment.run.replications
        val plan =
            StreamPlan(
                experiment.variants.flatMap { variant -> (0 until replications).flatMap { PathStreams.keys(variant.chain, it) } },
            )
        val tasks = experiment.variants.indices.flatMap { variant -> (0 until replications).map { variant to it } }
        val results = Array(experiment.variants.size) { arrayOfNulls<ReplicationResult>(replications) }
        val progress = Progress(tasks.size, onProgress)
        val futures = mutableListOf<Future<*>>()
        try {
            tasks.forEach { (variant, replication) ->
                futures +=
                    pool.submit(
                        Callable {
                            val result =
                                try {
                                    replicate(experiment.variants[variant].chain, plan, experiment.run.seed, replication)
                                } catch (failure: ExperimentExecutionException) {
                                    val id = experiment.variants[variant].id
                                    val message = "Variant '$id', replication ${replication + 1}: ${failure.message}"
                                    throw ExperimentExecutionException(message, failure)
                                }
                            synchronized(results) { results[variant][replication] = result }
                            progress.completeOne()
                        },
                    )
            }
            futures.forEach { future ->
                try {
                    future.get()
                } catch (exception: ExecutionException) {
                    throw exception.cause ?: exception
                }
            }
        } finally {
            futures.forEach { it.cancel(true) }
        }
        return ExperimentRun(
            experiment.variants.mapIndexed { index, variant ->
                val variantReplications = results[index].map { requireNotNull(it) }
                VariantRun(variant.id, variant.label, variantReplications, MetricsAggregator.aggregate(variantReplications))
            },
        )
    }

    /** Stops the worker threads; tasks still running are interrupted. */
    override fun close() {
        pool.shutdownNow().forEach { (it as? Future<*>)?.cancel(true) }
    }

    companion object {
        /** All cores but one, so the server stays responsive (ADR 0009). */
        fun defaultWorkers(): Int = maxOf(1, Runtime.getRuntime().availableProcessors() - 1)
    }
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
