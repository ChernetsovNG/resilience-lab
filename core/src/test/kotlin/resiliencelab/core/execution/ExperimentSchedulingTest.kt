package resiliencelab.core.execution

import ksl.simulation.Executive
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.simulation.ModelElement
import ksl.utilities.observers.ObserverIfc
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.engine.ksl.PathStreamSource
import resiliencelab.core.engine.ksl.ReliabilityModel
import resiliencelab.core.engine.ksl.TestChains
import resiliencelab.core.experiment.ReplicationResult
import java.util.Collections
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test

class ExperimentSchedulingTest {
    @Test
    fun `later short job finishes before a long job with round robin task order`() {
        val firstTaskStarted = CountDownLatch(1)
        val releaseFirstTask = CountDownLatch(1)
        val releaseLastTask = CountDownLatch(1)
        val shortFinished = CountDownLatch(1)
        val order = Collections.synchronizedList(mutableListOf<Pair<Long, Int>>())
        val executor =
            ExperimentExecutor(workers = 1) { _, _, seed, replication ->
                order += seed to replication
                if (seed == 11L && replication == 0) {
                    firstTaskStarted.countDown()
                    check(releaseFirstTask.await(5, TimeUnit.SECONDS))
                }
                if (seed == 11L && replication == 4) check(releaseLastTask.await(5, TimeUnit.SECONDS))
                emptyResult()
            }
        val longRun = FutureTask { executor.run(experiment(seed = 11, replications = 5)) }
        val shortRun = FutureTask { executor.run(experiment(seed = 22, replications = 2)) }
        val longRunner = thread(isDaemon = true) { longRun.run() }
        var shortRunner: Thread? = null

        try {
            assertThat(firstTaskStarted.await(5, TimeUnit.SECONDS)).isTrue()
            shortRunner =
                thread(isDaemon = true) {
                    shortRun.run()
                    shortFinished.countDown()
                }
            awaitWaiting(shortRunner)
            releaseFirstTask.countDown()

            assertThat(shortFinished.await(3, TimeUnit.SECONDS)).isTrue()
            assertThat(
                shortRun
                    .get(5, TimeUnit.SECONDS)
                    .variants
                    .single()
                    .replications,
            ).hasSize(2)
            assertThat(longRun.isDone).isFalse()
            releaseLastTask.countDown()
            longRun.get(5, TimeUnit.SECONDS)
            assertThat(order).containsExactly(11L to 0, 11L to 1, 22L to 0, 11L to 2, 22L to 1, 11L to 3, 11L to 4)
        } finally {
            releaseFirstTask.countDown()
            releaseLastTask.countDown()
            executor.close()
            longRunner.interrupt()
            shortRunner?.interrupt()
            longRunner.join(5_000)
            shortRunner?.join(5_000)
        }
    }

    @Test
    fun `cancelling a queued job returns without starting its tasks`() {
        val occupied = CountDownLatch(1)
        val release = CountDownLatch(1)
        val cancelled = AtomicBoolean()
        val starts = Collections.synchronizedList(mutableListOf<Long>())
        val executor =
            ExperimentExecutor(workers = 1) { _, _, seed, _ ->
                starts += seed
                if (seed == 11L) {
                    occupied.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                }
                emptyResult()
            }
        val running = FutureTask { executor.run(experiment(seed = 11, replications = 1)) }
        val queued =
            FutureTask {
                runCatching { executor.run(experiment(seed = 22, replications = 3), isCancelled = cancelled::get) }.exceptionOrNull()
            }
        val runner = thread(isDaemon = true) { running.run() }
        var queuedRunner: Thread? = null

        try {
            assertThat(occupied.await(5, TimeUnit.SECONDS)).isTrue()
            queuedRunner = thread(isDaemon = true) { queued.run() }
            awaitWaiting(queuedRunner)
            cancelled.set(true)

            assertThat(queued.get(3, TimeUnit.SECONDS)).isInstanceOf(CancellationException::class.java)
            release.countDown()
            running.get(5, TimeUnit.SECONDS)
            executor.run(experiment(seed = 33, replications = 1))
            assertThat(starts).containsExactly(11L, 33L)
        } finally {
            release.countDown()
            executor.close()
            runner.interrupt()
            queuedRunner?.interrupt()
            runner.join(5_000)
            queuedRunner?.join(5_000)
        }
    }

    @Test
    fun `cancelling active KSL models frees every worker and preserves other results`() {
        val started = CountDownLatch(2)
        val stopped = CountDownLatch(2)
        val starts = AtomicInteger()
        val cancelled = AtomicBoolean()
        val executor =
            ExperimentExecutor(workers = 2) { chain, plan, seed, replication ->
                val model = Model("cancellation-test", autoCSVReports = false)
                if (seed == 11L) {
                    object : ModelElement(model, "cancellation-probe") {
                        init {
                            var observed = false
                            executive.attachObserver(
                                object : ObserverIfc<KSLEvent<*>?> {
                                    override fun onChange(newValue: KSLEvent<*>?) {
                                        if (!observed && executive.status == Executive.Status.AFTER_EVENT) {
                                            observed = true
                                            starts.incrementAndGet()
                                            started.countDown()
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
                try {
                    ReliabilityModel(model, chain, PathStreamSource(plan, seed, replication.toLong())).runReplication()
                } finally {
                    if (seed == 11L) stopped.countDown()
                }
            }
        val heavy = experiment(seed = 11, replications = 10, measurementMs = 100_000_000.0)
        val normal = experiment(seed = 22, replications = 2)
        val expected = ExperimentExecutor(workers = 1).use { it.run(normal) }
        val cancelledRun = FutureTask { runCatching { executor.run(heavy, isCancelled = cancelled::get) }.exceptionOrNull() }
        val survivingRun = FutureTask { executor.run(normal) }
        val runner = thread(isDaemon = true) { cancelledRun.run() }
        var survivor: Thread? = null

        try {
            val running = started.await(5, TimeUnit.SECONDS)
            if (!running && cancelledRun.isDone) throw AssertionError("KSL job failed before starting", cancelledRun.get())
            assertThat(running).isTrue()
            survivor = thread(isDaemon = true) { survivingRun.run() }
            awaitWaiting(survivor)
            cancelled.set(true)

            assertThat(cancelledRun.get(3, TimeUnit.SECONDS)).isInstanceOf(CancellationException::class.java)
            assertThat(stopped.await(3, TimeUnit.SECONDS)).isTrue()
            assertThat(starts.get()).isEqualTo(2)
            assertThat(survivingRun.get(3, TimeUnit.SECONDS)).isEqualTo(expected)
        } finally {
            cancelled.set(true)
            executor.close()
            runner.interrupt()
            survivor?.interrupt()
            runner.join(5_000)
            survivor?.join(5_000)
        }
    }

    private fun experiment(
        seed: Long,
        replications: Int,
        measurementMs: Double = 100.0,
    ): CompiledExperiment {
        val settings = TestChains.run(seed = seed, replications = replications, measurementMs = measurementMs, maxRealTimeSeconds = 5L)
        return CompiledExperiment(listOf(CompiledVariant("baseline", "Baseline", TestChains.simple().copy(run = settings))), settings)
    }

    private fun emptyResult() = ReplicationResult(emptyList(), emptyList(), emptyList(), emptyList(), 0, 0, 0, emptyMap())

    private fun awaitWaiting(runner: Thread) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        val waiting = setOf(Thread.State.WAITING, Thread.State.TIMED_WAITING)
        while (runner.state !in waiting && System.nanoTime() < deadline) Thread.yield()
        assertThat(runner.state).isIn(waiting)
    }
}
