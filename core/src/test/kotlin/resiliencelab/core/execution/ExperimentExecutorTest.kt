package resiliencelab.core.execution

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import java.util.Collections
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.test.Test

class ExperimentExecutorTest {
    private val run = RunSettings(replications = 3, warmupMs = 0.0, measurementMs = 300.0, seed = 11, maxRealTimeSeconds = 30)

    private fun chain(attempts: Int) =
        ChainIr(
            client = ClientNode("client", 0.05, 200.0),
            entry = "front",
            services =
                listOf(
                    ServiceNode("back", 1, 2, Distribution(DistributionShape.EXPONENTIAL, 6.0), 0.02),
                    ServiceNode("front", 2, 4, Distribution(DistributionShape.FIXED, 1.0), 0.0),
                ),
            calls =
                listOf(
                    CallEdge(
                        path = "front-to-back",
                        from = "front",
                        to = "back",
                        network = Distribution(DistributionShape.FIXED, 0.5),
                        timeoutMs = 15.0,
                        attempts = attempts,
                        backoff = Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 1.0, 4.0, 2.0),
                    ),
                ),
            faults = emptyList(),
            run = run,
        )

    private val experiment =
        CompiledExperiment(
            variants = listOf(CompiledVariant("baseline", "Baseline", chain(3)), CompiledVariant("single", "Single", chain(1))),
            run = run,
        )

    @Test
    fun `results do not depend on the number of workers`() {
        val sequential = ExperimentExecutor(workers = 1).run(experiment)
        val parallel = ExperimentExecutor(workers = 4).run(experiment)

        assertThat(parallel).isEqualTo(sequential)
        assertThat(sequential.variants.map { it.id }).containsExactly("baseline", "single")
        assertThat(sequential.variants.map { it.label }).containsExactly("Baseline", "Single")
        assertThat(sequential.variants.first().replications).hasSize(3)
    }

    @Test
    fun `identical variants share common random numbers`() {
        val twins =
            experiment.copy(variants = listOf(CompiledVariant("a", "A", chain(2)), CompiledVariant("b", "B", chain(2))))

        val result = ExperimentExecutor(workers = 2).run(twins)

        assertThat(result.variants[0].replications).isEqualTo(result.variants[1].replications)
    }

    @Test
    fun `reports progress for every task in increasing order`() {
        val progress = Collections.synchronizedList(mutableListOf<Pair<Int, Int>>())

        ExperimentExecutor(workers = 3).run(experiment) { completed, total -> progress += completed to total }

        assertThat(progress).containsExactly(1 to 6, 2 to 6, 3 to 6, 4 to 6, 5 to 6, 6 to 6)
    }

    @Test
    fun `concurrent runs of one executor share its workers`() {
        val active = AtomicInteger()
        val peak = AtomicInteger()
        val executor =
            ExperimentExecutor(workers = 1) { _, _, _, _ ->
                peak.accumulateAndGet(active.incrementAndGet()) { a, b -> maxOf(a, b) }
                Thread.sleep(20)
                active.decrementAndGet()
                ReplicationResult(emptyList(), emptyList(), emptyList(), emptyList(), 0, 0, 0, emptyMap())
            }

        val runs = (1..2).map { thread { executor.run(experiment) } }
        runs.forEach { it.join() }

        assertThat(peak.get()).isEqualTo(1)
    }

    @Test
    fun `closing while replications are queued does not strand the run`() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val executor =
            ExperimentExecutor(workers = 1) { _, _, _, _ ->
                started.countDown()
                var released = false
                while (!released) {
                    try {
                        release.await()
                        released = true
                    } catch (_: InterruptedException) {
                        // Keep the active replication alive until the test releases it.
                    }
                }
                ReplicationResult(emptyList(), emptyList(), emptyList(), emptyList(), 0, 0, 0, emptyMap())
            }
        val runner =
            thread {
                try {
                    executor.run(experiment)
                } catch (exception: Throwable) {
                    failure.set(exception)
                }
            }

        try {
            assertThat(started.await(5, TimeUnit.SECONDS)).isTrue
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (runner.state != Thread.State.WAITING && System.nanoTime() < deadline) Thread.yield()
            assertThat(runner.state).isEqualTo(Thread.State.WAITING)

            executor.close()
            release.countDown()
            runner.join(TimeUnit.SECONDS.toMillis(5))

            assertThat(runner.isAlive).isFalse
            assertThat(failure.get()).isInstanceOf(CancellationException::class.java)
        } finally {
            release.countDown()
            executor.close()
            runner.interrupt()
            runner.join(TimeUnit.SECONDS.toMillis(5))
        }
    }

    @Test
    fun `a closed executor accepts no runs`() {
        val executor = ExperimentExecutor(workers = 1)
        executor.close()

        assertThatThrownBy { executor.run(experiment) }.isInstanceOf(RejectedExecutionException::class.java)
    }

    @Test
    fun `rethrows the failure of a task`() {
        val failing = ExperimentExecutor(workers = 2) { _, _, _, _ -> throw IllegalStateException("boom") }

        assertThatThrownBy { failing.run(experiment) }.isInstanceOf(IllegalStateException::class.java).hasMessage("boom")
    }
}
