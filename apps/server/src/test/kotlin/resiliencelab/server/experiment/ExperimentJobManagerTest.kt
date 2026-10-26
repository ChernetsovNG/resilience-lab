package resiliencelab.server.experiment

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor
import resiliencelab.core.experiment.ExperimentResult
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.ExperimentDocument
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit.SECONDS

class ExperimentJobManagerTest {
    private val executors = mutableListOf<RecordingExecutor>()

    @AfterEach
    fun closeExecutors() {
        executors.forEach(RecordingExecutor::close)
    }

    @Test
    fun `queued job becomes running and then completed only after its executor is released`() {
        val executor = recordingExecutor(threads = 1)
        val firstStarted = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val secondStarted = CountDownLatch(1)
        val releaseSecond = CountDownLatch(1)
        val experimentExecutor =
            ExperimentExecutor { document ->
                when (document.execution.seed) {
                    1L -> {
                        firstStarted.countDown()
                        check(releaseFirst.await(5, SECONDS))
                    }
                    2L -> {
                        secondStarted.countDown()
                        check(releaseSecond.await(5, SECONDS))
                    }
                    else -> error("Unexpected document")
                }
                result
            }
        val manager = ExperimentJobManager(executor, experimentExecutor)
        val firstDocument = document(seed = 1)
        val secondDocument = document(seed = 2)

        val firstId = manager.submit(firstDocument)
        assertThat(firstStarted.await(5, SECONDS)).isTrue()
        val secondId = manager.submit(secondDocument)

        assertThat(manager.get(secondId)).isEqualTo(ExperimentJob(secondId, ExperimentJobStatus.QUEUED, null, null))
        assertThat(manager.get(UUID.randomUUID())).isNull()

        releaseFirst.countDown()
        assertThat(secondStarted.await(5, SECONDS)).isTrue()
        assertThat(manager.get(secondId)).isEqualTo(ExperimentJob(secondId, ExperimentJobStatus.RUNNING, null, null))
        assertThat(manager.get(secondId)?.result).isNull()
        assertThat(manager.get(secondId)?.error).isNull()

        releaseSecond.countDown()
        assertThat(executor.awaitCompletion(1)).isTrue()
        assertThat(manager.get(firstId)).isEqualTo(ExperimentJob(firstId, ExperimentJobStatus.COMPLETED, result, null))
        assertThat(manager.get(secondId)).isEqualTo(ExperimentJob(secondId, ExperimentJobStatus.COMPLETED, result, null))
    }

    @Test
    fun `second job completes independently while first job is blocked`() {
        val executor = recordingExecutor(threads = 2)
        val firstStarted = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val manager =
            ExperimentJobManager(
                executor,
                ExperimentExecutor { document ->
                    if (document.execution.seed == 1L) {
                        firstStarted.countDown()
                        check(releaseFirst.await(5, SECONDS))
                    }
                    result
                },
            )

        val firstId = manager.submit(document(seed = 1))
        assertThat(firstStarted.await(5, SECONDS)).isTrue()
        val secondId = manager.submit(document(seed = 2))

        assertThat(executor.awaitCompletion(1)).isTrue()
        assertThat(manager.get(secondId)).isEqualTo(ExperimentJob(secondId, ExperimentJobStatus.COMPLETED, result, null))
        assertThat(manager.get(firstId)).isEqualTo(ExperimentJob(firstId, ExperimentJobStatus.RUNNING, null, null))

        releaseFirst.countDown()
        assertThat(executor.awaitCompletion(0)).isTrue()
    }

    @Test
    fun `failed job exposes only safe error text without changing another job result`() {
        val executor = recordingExecutor(threads = 2)
        val successStarted = CountDownLatch(1)
        val releaseSuccess = CountDownLatch(1)
        val manager =
            ExperimentJobManager(
                executor,
                ExperimentExecutor { document ->
                    if (document.execution.seed == 1L) {
                        successStarted.countDown()
                        check(releaseSuccess.await(5, SECONDS))
                        result
                    } else {
                        throw IllegalStateException("simulation failed safely")
                    }
                },
            )

        val successId = manager.submit(document(seed = 1))
        assertThat(successStarted.await(5, SECONDS)).isTrue()
        val failedId = manager.submit(document(seed = 2))

        assertThat(executor.awaitCompletion(1)).isTrue()
        val failed = manager.get(failedId)
        assertThat(failed).isEqualTo(
            ExperimentJob(failedId, ExperimentJobStatus.FAILED, null, "simulation failed safely"),
        )
        assertThat(failed?.error).doesNotContain("IllegalStateException", "at resiliencelab", "\n\tat ")
        assertThat(manager.get(successId)).isEqualTo(ExperimentJob(successId, ExperimentJobStatus.RUNNING, null, null))

        releaseSuccess.countDown()
        assertThat(executor.awaitCompletion(0)).isTrue()
        assertThat(manager.get(successId)).isEqualTo(ExperimentJob(successId, ExperimentJobStatus.COMPLETED, result, null))
        assertThat(manager.get(failedId)).isEqualTo(failed)
    }

    @Test
    fun `failure without exception message uses safe generic error`() {
        val executor = recordingExecutor(threads = 1)
        val manager =
            ExperimentJobManager(
                executor,
                ExperimentExecutor { throw IllegalStateException() },
            )

        val id = manager.submit(document())

        assertThat(executor.awaitCompletion(0)).isTrue()
        assertThat(manager.get(id)).isEqualTo(
            ExperimentJob(id, ExperimentJobStatus.FAILED, null, "Experiment execution failed"),
        )
    }

    @Test
    fun `rejected submission becomes failed instead of remaining queued`() {
        val manager =
            ExperimentJobManager(
                Executor { throw RejectedExecutionException("simulation capacity exhausted") },
                ExperimentExecutor { result },
            )

        val id = manager.submit(document())

        assertThat(manager.get(id)).isEqualTo(
            ExperimentJob(id, ExperimentJobStatus.FAILED, null, "simulation capacity exhausted"),
        )
    }

    private fun recordingExecutor(threads: Int): RecordingExecutor = RecordingExecutor(threads).also(executors::add)

    private class RecordingExecutor(
        threads: Int,
    ) : Executor,
        AutoCloseable {
        private val delegate =
            ThreadPoolTaskExecutor().apply {
                corePoolSize = threads
                maxPoolSize = threads
                queueCapacity = 100
                initialize()
            }
        private val completions = CopyOnWriteArrayList<CountDownLatch>()

        override fun execute(command: Runnable) {
            val completion = CountDownLatch(1)
            completions += completion
            delegate.execute {
                try {
                    command.run()
                } finally {
                    completion.countDown()
                }
            }
        }

        fun awaitCompletion(taskIndex: Int): Boolean = completions[taskIndex].await(5, SECONDS)

        override fun close() = delegate.destroy()
    }

    private companion object {
        val result =
            ExperimentResult(
                schemaVersion = 1,
                applicationVersion = "test",
                kslVersion = "test",
                variants = emptyList(),
            )

        fun document(seed: Long = 42): ExperimentDocument =
            ExperimentDocument(
                schemaVersion = 1,
                execution =
                    Execution(
                        replications = 1,
                        warmupMs = 0.0,
                        measurementMs = 1.0,
                        seed = seed,
                        maxRealTimeSeconds = 60,
                    ),
                variants = emptyList(),
            )
    }
}
