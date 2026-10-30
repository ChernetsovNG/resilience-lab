package resiliencelab.core.execution

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.assertj.core.data.Offset.offset
import org.junit.jupiter.api.Tag
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledPoint
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.engine.ksl.ExperimentExecutionException
import resiliencelab.core.engine.ksl.TestChains
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.GraphIr
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
    private fun variant(
        id: String,
        label: String,
        chain: GraphIr,
    ) = CompiledVariant(id, label, listOf(CompiledPoint("p0", emptyMap(), chain)))

    private val run = RunSettings(replications = 3, warmupMs = 0.0, measurementMs = 300.0, seed = 11, maxRealTimeSeconds = 30)

    private fun chain(attempts: Int) =
        GraphIr(
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
            variants = listOf(variant("baseline", "Baseline", chain(3)), variant("single", "Single", chain(1))),
            run = run,
        )

    @Test
    fun `results do not depend on the number of workers`() {
        val sequential = ExperimentExecutor(workers = 1).run(experiment)
        val parallel = ExperimentExecutor(workers = 4).run(experiment)

        assertThat(parallel).isEqualTo(sequential)
        assertThat(sequential.variants.map { it.id }).containsExactly("baseline", "single")
        assertThat(sequential.variants.map { it.label }).containsExactly("Baseline", "Single")
        assertThat(
            sequential.variants
                .first()
                .points
                .single()
                .replications,
        ).hasSize(3)
    }

    @Test
    fun `identical variants share common random numbers`() {
        val twins =
            experiment.copy(variants = listOf(variant("a", "A", chain(2)), variant("b", "B", chain(2))))

        val result = ExperimentExecutor(workers = 2).run(twins)

        assertThat(
            result.variants[0]
                .points
                .single()
                .replications,
        ).isEqualTo(
            result.variants[1]
                .points
                .single()
                .replications,
        )
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
                ReplicationResult(
                    emptyList(),
                    resiliencelab.core.experiment.LatencyStatistics(),
                    resiliencelab.core.experiment.LatencyStatistics(),
                    resiliencelab.core.experiment.LatencyStatistics(),
                    0,
                    0,
                    0,
                    emptyMap(),
                )
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
                ReplicationResult(
                    emptyList(),
                    resiliencelab.core.experiment.LatencyStatistics(),
                    resiliencelab.core.experiment.LatencyStatistics(),
                    resiliencelab.core.experiment.LatencyStatistics(),
                    0,
                    0,
                    0,
                    emptyMap(),
                )
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
            val waiting = setOf(Thread.State.WAITING, Thread.State.TIMED_WAITING)
            while (runner.state !in waiting && System.nanoTime() < deadline) Thread.yield()
            assertThat(runner.state).isIn(waiting)

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

    @Test
    fun `different seeds change arrival streams`() {
        fun arrivals(seed: Long) =
            ExperimentExecutor(workers = 1).use { executor ->
                executor
                    .run(experimentOf(TestChains.run(measurementMs = 100.0, seed = seed, replications = 2), "baseline" to singleService()))
                    .variants
                    .single()
                    .points
                    .single()
                    .replications
                    .map { it.arrivalTimesMs }
            }

        assertThat(arrivals(43L)).isNotEqualTo(arrivals(42L))
    }

    @Test
    fun `paired variants share arrival timestamps`() {
        val result =
            ExperimentExecutor(workers = 2).use { executor ->
                executor.run(
                    experimentOf(
                        TestChains.run(measurementMs = 100.0, replications = 3),
                        "baseline" to singleService(processing = TestChains.fixed(1.0)),
                        "candidate" to singleService(processing = TestChains.fixed(2.0)),
                    ),
                )
            }

        val (baseline, candidate) = result.variants
        baseline.points.single().replications.indices.forEach { index ->
            assertThat(
                candidate.points
                    .single()
                    .replications[index]
                    .arrivalTimesMs,
            ).isEqualTo(
                baseline.points
                    .single()
                    .replications[index]
                    .arrivalTimesMs,
            )
        }
    }

    @Test
    fun `each replication draws arrivals from its own path stream`() {
        val settings = TestChains.run(measurementMs = 100.0, replications = 3)

        val instant = experimentOf(settings, "baseline" to singleService(processing = TestChains.fixed(0.0)))

        val result = ExperimentExecutor(workers = 3).use { it.run(instant) }

        val actual =
            result.variants
                .single()
                .points
                .single()
                .replications
                .map { it.arrivalTimesMs }
        val expected = (0 until 3).map { TestChains.expectedArrivals(settings.seed, 0.25, settings.measurementMs, replication = it) }
        assertThat(actual).isEqualTo(expected)
        assertThat(actual[1]).isNotEqualTo(actual[0])
    }

    @Test
    fun `a capped replication fails the whole experiment and names its variant`() {
        val settings = TestChains.run(measurementMs = 100_000.0, replications = 2, maxRealTimeSeconds = 1L)
        val capped =
            singleService(
                arrivalRatePerMs = 1_000.0,
                processing = TestChains.fixed(100.0),
                queueCapacity = 100_000,
                deadlineMs = 1_000_000_000.0,
            )

        assertThatThrownBy {
            ExperimentExecutor(workers = 2).use { executor ->
                executor.run(
                    experimentOf(
                        settings,
                        "valid" to singleService(arrivalRatePerMs = 0.001, processing = TestChains.fixed(0.0)),
                        "capped" to capped,
                    ),
                )
            }
        }.isInstanceOf(ExperimentExecutionException::class.java)
            .hasMessageContaining("Variant 'capped'")
            .hasMessageContaining("replication ")
            .hasMessageMatching("Variant 'capped', point 'p0', replication [12]: .*")
            .hasMessageContaining("real-time cap")
            .hasCauseInstanceOf(ExperimentExecutionException::class.java)
    }

    @Test
    @Tag("analytic")
    fun `single service matches MM1 utilization and response time`() {
        val settings = TestChains.run(warmupMs = 10_000.0, measurementMs = 400_000.0, maxRealTimeSeconds = 120L)
        val chain = singleService(processing = TestChains.exponential(2.0), queueCapacity = 100_000, deadlineMs = 1_000_000_000.0)

        val windows = mutableListOf<resiliencelab.core.results.WindowMetrics>()
        val variant =
            ExperimentExecutor(workers = 1).use { executor ->
                executor
                    .run(
                        experimentOf(settings, "mm1" to chain),
                        onWindow = { _, _, _, _, rows, _ -> windows += rows.single { it.id == "entry" }.metrics },
                    ).variants
                    .single()
            }

        val replication =
            variant.points
                .single()
                .replications
                .single()
        val utilization = replication.services.getValue("entry").handlerUtilization
        val meanResponseMs =
            variant.points
                .single()
                .aggregate.pooledLatency.all!!
                .meanMs
        assertThat(replication.successes).isEqualTo(replication.originalArrivals)
        assertThat(replication.failures).isZero()
        assertThat(utilization).isCloseTo(0.5, offset(0.03))
        val windowUtilization = windows.sumOf { it.busyHandlerTimeMs } / windows.sumOf { it.handlers * it.durationMs }
        assertThat(windowUtilization).isCloseTo(utilization, offset(0.03))
        windows.forEach { assertThat(it.busyHandlerTimeMs / (it.handlers * it.durationMs)).isBetween(0.0, 1.0) }
        assertThat(meanResponseMs).isCloseTo(4.0, offset(0.25))
    }

    /** One service behind the client. */
    private fun singleService(
        arrivalRatePerMs: Double = 0.25,
        processing: Distribution = TestChains.fixed(1.0),
        queueCapacity: Int = 1_000,
        deadlineMs: Double = 10_000.0,
    ): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            client = base.client.copy(arrivalRatePerMs = arrivalRatePerMs, deadlineMs = deadlineMs),
            services =
                listOf(
                    base.services.first().copy(
                        handlers = 1,
                        queueCapacity = queueCapacity,
                        processing = processing,
                        failureProbability = 0.0,
                    ),
                ),
            calls = emptyList(),
        )
    }

    private fun experimentOf(
        settings: RunSettings,
        vararg variants: Pair<String, GraphIr>,
    ): CompiledExperiment =
        CompiledExperiment(
            variants = variants.map { (id, chain) -> variant(id, id, chain.copy(run = settings)) },
            run = settings,
        )

    @Test
    fun `task submission order does not change variant results`() {
        ExperimentExecutor(workers = 2).use { executor ->
            val original = executor.run(experiment).variants.associateBy { it.id }
            val reversed = executor.run(experiment.copy(variants = experiment.variants.reversed())).variants.associateBy { it.id }
            assertThat(reversed).isEqualTo(original)
        }
    }
}
