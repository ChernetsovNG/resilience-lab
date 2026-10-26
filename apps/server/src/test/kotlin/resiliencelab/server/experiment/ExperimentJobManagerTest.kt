package resiliencelab.server.experiment

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.springframework.boot.test.system.CapturedOutput
import org.springframework.boot.test.system.OutputCaptureExtension
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

@ExtendWith(OutputCaptureExtension::class)
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
    fun `failed job exposes only safe error text without changing another job result`(output: CapturedOutput) {
        val executor = recordingExecutor(threads = 2)
        val successStarted = CountDownLatch(1)
        val releaseSuccess = CountDownLatch(1)
        val hostileMessage =
            "simulation failed safely\njava.lang.IllegalStateException: internal detail\n\tat resiliencelab.Secret.run"
        val manager =
            ExperimentJobManager(
                executor,
                ExperimentExecutor { document ->
                    if (document.execution.seed == 1L) {
                        successStarted.countDown()
                        check(releaseSuccess.await(5, SECONDS))
                        result
                    } else {
                        throw IllegalStateException(hostileMessage)
                    }
                },
            )

        val successId = manager.submit(document(seed = 1))
        assertThat(successStarted.await(5, SECONDS)).isTrue()
        val failedId = manager.submit(document(seed = 2))

        assertThat(executor.awaitCompletion(1)).isTrue()
        val failed = manager.get(failedId)
        assertThat(failed).isEqualTo(
            ExperimentJob(failedId, ExperimentJobStatus.FAILED, null, "Experiment execution failed"),
        )
        assertThat(failed?.error).doesNotContain(
            hostileMessage,
            "IllegalStateException",
            "at resiliencelab",
            "\n\tat ",
        )
        assertThat(output).contains(failedId.toString(), hostileMessage)
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
    fun `rejected submission becomes failed instead of remaining queued`(output: CapturedOutput) {
        val hostileMessage =
            "simulation capacity exhausted\njava.util.concurrent.RejectedExecutionException: pool detail\n\tat org.springframework.Secret.execute"
        val manager =
            ExperimentJobManager(
                Executor { throw RejectedExecutionException(hostileMessage) },
                ExperimentExecutor { result },
            )

        val id = manager.submit(document())
        val failed = manager.get(id)

        assertThat(failed).isEqualTo(
            ExperimentJob(id, ExperimentJobStatus.FAILED, null, "Experiment execution failed"),
        )
        assertThat(failed?.error).doesNotContain(
            hostileMessage,
            "RejectedExecutionException",
            "at org.springframework",
            "\n\tat ",
        )
        assertThat(output).contains(id.toString(), hostileMessage)
    }

    @Test
    fun `terminal retention evicts oldest failed jobs and retains newest`() {
        val manager =
            ExperimentJobManager(
                Executor { throw RejectedExecutionException("capacity") },
                ExperimentExecutor { result },
            )

        val ids = (1..101).map { manager.submit(document()) }

        assertThat(manager.get(ids.first())).isNull()
        assertThat(manager.get(ids[1])).isEqualTo(
            ExperimentJob(ids[1], ExperimentJobStatus.FAILED, null, "Experiment execution failed"),
        )
        assertThat(manager.get(ids.last())).isEqualTo(
            ExperimentJob(ids.last(), ExperimentJobStatus.FAILED, null, "Experiment execution failed"),
        )
    }

    @Test
    fun `terminal saturation never evicts a blocked running job`() {
        val executor = recordingExecutor(threads = 1, queueCapacity = 0)
        val activeStarted = CountDownLatch(1)
        val releaseActive = CountDownLatch(1)
        val manager =
            ExperimentJobManager(
                executor,
                ExperimentExecutor {
                    activeStarted.countDown()
                    check(releaseActive.await(5, SECONDS))
                    result
                },
            )
        val activeId = manager.submit(document())
        assertThat(activeStarted.await(5, SECONDS)).isTrue()

        try {
            val rejectedIds = (1..101).map { manager.submit(document()) }

            assertThat(manager.get(activeId)).isEqualTo(
                ExperimentJob(activeId, ExperimentJobStatus.RUNNING, null, null),
            )
            assertThat(manager.get(rejectedIds.first())).isNull()
            assertThat(manager.get(rejectedIds.last())).isNotNull()
        } finally {
            releaseActive.countDown()
            assertThat(executor.awaitCompletion(0)).isTrue()
        }
    }

    private fun recordingExecutor(
        threads: Int,
        queueCapacity: Int = 100,
    ): RecordingExecutor = RecordingExecutor(threads, queueCapacity).also(executors::add)

    private class RecordingExecutor(
        threads: Int,
        queueCapacity: Int,
    ) : Executor,
        AutoCloseable {
        private val delegate =
            ThreadPoolTaskExecutor().apply {
                corePoolSize = threads
                maxPoolSize = threads
                this.queueCapacity = queueCapacity
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
