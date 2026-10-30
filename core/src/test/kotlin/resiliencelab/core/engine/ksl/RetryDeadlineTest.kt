package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.experiment.assertLatencies
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RunSettings
import kotlin.test.Test

class RetryDeadlineTest {
    @Test
    fun `none backoff is zero without sampling jitter`() {
        val backoff = TestChains.backoff(BackoffKind.NONE, 100.0, 7_000.0, multiplier = 3.0)
        var jitterSampled = false

        val delayMs =
            RetryPolicyEvaluator.backoffMs(backoff, failedAttemptNumber = 1) {
                jitterSampled = true
                0.999
            }

        assertThat(delayMs).isCloseTo(0.0, offset(0.0))
        assertThat(jitterSampled).isFalse()
    }

    @Test
    fun `fixed backoff is the minimum of base and cap`() {
        val belowCap = TestChains.backoff(BackoffKind.FIXED, 100.0, 7_000.0, multiplier = 3.0)
        val aboveCap = belowCap.copy(maxMs = 50.0)

        assertThat(RetryPolicyEvaluator.backoffMs(belowCap, 1) { 0.999 }).isCloseTo(100.0, offset(0.0))
        assertThat(RetryPolicyEvaluator.backoffMs(aboveCap, 4) { 0.999 }).isCloseTo(50.0, offset(0.0))
    }

    @Test
    fun `exponential backoff uses configurable base three and the cap`() {
        val backoff = TestChains.backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 100.0, 7_000.0, multiplier = 3.0)

        val delaysMs =
            (1..6).map { failedAttempt ->
                RetryPolicyEvaluator.backoffMs(backoff, failedAttempt) { 1.0 }
            }

        assertThat(delaysMs).containsExactly(100.0, 300.0, 900.0, 2700.0, 7000.0, 7000.0)
    }

    @Test
    fun `full jitter scales the capped exponential delay`() {
        val backoff = TestChains.backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 100.0, 7_000.0, multiplier = 3.0)

        val zero = RetryPolicyEvaluator.backoffMs(backoff, failedAttemptNumber = 5) { 0.0 }
        val almostCap = RetryPolicyEvaluator.backoffMs(backoff, failedAttemptNumber = 5) { 0.999 }

        assertThat(zero).isCloseTo(0.0, offset(0.0))
        assertThat(almostCap).isCloseTo(6_993.0, offset(1e-9))
        assertThat(almostCap).isBetween(0.0, 7_000.0)
    }

    @Test
    fun `queue rejection is retried with a fresh child and then succeeds`() {
        val rig =
            simulate(
                chain =
                    chain(
                        backendProcessingMs = 10.0,
                        backendQueueCapacity = 0,
                        backoff = fixedBackoff(20.0),
                    ),
                requests =
                    listOf(
                        InvocationSpec(originalRequest = false, serviceId = "backend"),
                        InvocationSpec(),
                    ),
                observationTimesMs = listOf(10.0),
            )

        val caller = rig.invocations[1]
        val firstAttempt = rig.observedAttempts.single()
        assertThat(firstAttempt).isNotNull()
        val secondAttempt = caller.callAttempt
        assertThat(secondAttempt).isNotNull()
        assertThat(secondAttempt).isNotSameAs(firstAttempt)
        assertThat(secondAttempt!!.child).isNotSameAs(firstAttempt!!.child)
        assertThat(firstAttempt.child.outcome).isEqualTo(AttemptOutcome.QUEUE_REJECTED)
        assertThat(secondAttempt.child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(30.0, offset(0.0))

        val result = rig.result()
        assertLatencies(result.successfulLatency, 30.0)
        assertThat(result.services.getValue("entry").retries).isEqualTo(1)
        assertThat(result.services.getValue("backend").offeredAttempts).isEqualTo(3)
        assertThat(result.services.getValue("backend").admittedAttempts).isEqualTo(2)
        assertThat(
            result.services
                .getValue("backend")
                .slotPools
                .getValue("handlers")
                .queueFullCount,
        ).isEqualTo(1)
        assertDrained(rig)
    }

    @Test
    fun `downstream local failure is retryable`() {
        val rig =
            simulate(
                chain = chain(backendFailureRate = 0.5),
                requests = listOf(InvocationSpec()),
                seed = failureThenSuccessSeed(),
            )

        val caller = rig.invocations.single()
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(0.0, offset(0.0))
        val result = rig.result()
        assertLatencies(result.successfulLatency, 0.0)
        assertThat(result.services.getValue("backend").offeredAttempts).isEqualTo(2)
        assertThat(result.services.getValue("backend").admittedAttempts).isEqualTo(2)
        assertThat(result.services.getValue("backend").failures).isEqualTo(1)
        assertThat(result.services.getValue("entry").retries).isEqualTo(1)
        assertDrained(rig)
    }

    @Test
    fun `five max attempts means five total attempts and four retries`() {
        val rig =
            simulate(
                chain = chain(backendFailureRate = 1.0, attempts = 5),
                requests = listOf(InvocationSpec()),
            )

        val caller = rig.invocations.single()
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.DOWNSTREAM_FAILURE)
        val result = rig.result()
        assertThat(result.services.getValue("backend").offeredAttempts).isEqualTo(5)
        assertThat(result.services.getValue("backend").admittedAttempts).isEqualTo(5)
        assertThat(result.services.getValue("backend").failures).isEqualTo(5)
        assertThat(result.services.getValue("entry").retries).isEqualTo(4)
        assertThat(result.services.getValue("backend").retries).isZero()
        assertLatencies(result.failedLatency, 0.0)
        assertDrained(rig)
    }

    @Test
    fun `caller handler stays allocated during backoff while a second request waits`() {
        val rig =
            simulate(
                chain =
                    chain(
                        backendProcessingMs = 10.0,
                        backendQueueCapacity = 0,
                        backoff = fixedBackoff(20.0),
                    ),
                requests =
                    listOf(
                        InvocationSpec(originalRequest = false, serviceId = "backend"),
                        InvocationSpec(),
                        InvocationSpec(arrivalTimeMs = 5.0),
                    ),
                observationTimesMs = listOf(10.5),
            )

        assertThat(rig.observations).containsExactly(
            Snapshot(
                timeMs = 10.5,
                activeInvocations = 2,
                activeOriginalRequests = 2,
                activeDownstreamProcesses = 0,
                entryHandlerBusy = 1,
                backendHandlerBusy = 0,
                originalCompletions = 0,
            ),
        )
        assertThat(rig.invocations[1].work.processCompletionTime).isCloseTo(30.0, offset(0.0))
        assertThat(rig.invocations[2].work.processCompletionTime).isCloseTo(40.0, offset(0.0))
        assertLatencies(rig.result().successfulLatency, 30.0, 35.0)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .retries,
        ).isEqualTo(1)
        assertDrained(rig)
    }

    @Test
    fun `deadline during backoff prevents another attempt and completes the client once`() {
        val rig =
            simulate(
                chain =
                    chain(
                        backendProcessingMs = 100.0,
                        backendQueueCapacity = 0,
                        attempts = 5,
                        backoff = fixedBackoff(100.0),
                        requestDeadlineMs = 50.0,
                    ),
                requests =
                    listOf(
                        InvocationSpec(originalRequest = false, serviceId = "backend"),
                        InvocationSpec(),
                    ),
                observationTimesMs = listOf(50.5),
                replicationLengthMs = 150.0,
            )

        val caller = rig.invocations[1]
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.DEADLINE_EXCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(50.0, offset(0.0))
        assertThat(
            rig
                .result()
                .services
                .getValue("backend")
                .offeredAttempts,
        ).isEqualTo(2)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .retries,
        ).isZero()
        assertOriginalFailureOnce(rig.result(), 50.0)
        assertThat(rig.observations).containsExactly(
            Snapshot(
                timeMs = 50.5,
                activeInvocations = 1,
                activeOriginalRequests = 0,
                activeDownstreamProcesses = 0,
                entryHandlerBusy = 0,
                backendHandlerBusy = 1,
                originalCompletions = 1,
            ),
        )
        assertDrained(rig)
    }

    @Test
    fun `deadline during entry queue leaves queued orphan executing with one client failure`() {
        val rig =
            simulate(
                chain =
                    chain(
                        entryProcessingMs = 50.0,
                        requestDeadlineMs = 10.0,
                    ).copy(calls = emptyList()),
                requests =
                    listOf(
                        InvocationSpec(originalRequest = false),
                        InvocationSpec(),
                    ),
                observationTimesMs = listOf(10.5, 50.5),
                replicationLengthMs = 150.0,
            )

        val orphanedOriginal = rig.invocations[1]
        assertThat(orphanedOriginal.outcome).isEqualTo(AttemptOutcome.DEADLINE_EXCEEDED)
        assertThat(orphanedOriginal.work.isCompleted).isTrue()
        assertThat(orphanedOriginal.work.processCompletionTime).isCloseTo(100.0, offset(0.0))
        assertOriginalFailureOnce(rig.result(), 10.0)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .offeredAttempts,
        ).isEqualTo(2)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .admittedAttempts,
        ).isEqualTo(2)
        assertThat(rig.observations).containsExactly(
            Snapshot(
                timeMs = 10.5,
                activeInvocations = 2,
                activeOriginalRequests = 0,
                activeDownstreamProcesses = 0,
                entryHandlerBusy = 1,
                backendHandlerBusy = 0,
                originalCompletions = 1,
            ),
            Snapshot(
                timeMs = 50.5,
                activeInvocations = 1,
                activeOriginalRequests = 0,
                activeDownstreamProcesses = 0,
                entryHandlerBusy = 1,
                backendHandlerBusy = 0,
                originalCompletions = 1,
            ),
        )
        assertDrained(rig)
    }

    @Test
    fun `deadline during local processing drains accepted work without starting downstream`() {
        val rig =
            simulate(
                chain =
                    chain(
                        entryProcessingMs = 50.0,
                        requestDeadlineMs = 10.0,
                        timeoutMs = 500.0,
                    ),
                requests = listOf(InvocationSpec()),
                observationTimesMs = listOf(10.5),
                replicationLengthMs = 100.0,
            )

        val caller = rig.invocations.single()
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.DEADLINE_EXCEEDED)
        assertThat(caller.work.isCompleted).isTrue()
        assertThat(caller.work.processCompletionTime).isCloseTo(50.0, offset(0.0))
        assertThat(caller.callAttempt).isNull()
        assertThat(
            rig
                .result()
                .services
                .getValue("backend")
                .offeredAttempts,
        ).isZero()
        assertOriginalFailureOnce(rig.result(), 10.0)
        assertThat(rig.observations).containsExactly(
            Snapshot(
                timeMs = 10.5,
                activeInvocations = 1,
                activeOriginalRequests = 0,
                activeDownstreamProcesses = 0,
                entryHandlerBusy = 1,
                backendHandlerBusy = 0,
                originalCompletions = 1,
            ),
        )
        assertDrained(rig)
    }

    @Test
    fun `response at capped timeout and original deadline wins once without timeout`() {
        val rig =
            simulate(
                chain =
                    chain(
                        backendProcessingMs = 40.0,
                        timeoutMs = 500.0,
                        attempts = 1,
                        requestDeadlineMs = 40.0,
                    ),
                requests = listOf(InvocationSpec()),
                replicationLengthMs = 100.0,
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        assertThat(attempt!!.timeoutEvent.time).isCloseTo(40.0, offset(0.0))
        assertThat(attempt.child.work.processCompletionTime).isCloseTo(40.0, offset(0.0))
        assertThat(attempt.status).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(attempt.timeoutEvent.cancel).isTrue()
        assertThat(attempt.timeoutEvent.isScheduled).isFalse()
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(40.0, offset(0.0))

        val result = rig.result()
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isEqualTo(1)
        assertThat(result.failures).isZero()
        assertLatencies(result.allLatency, 40.0)
        assertLatencies(result.successfulLatency, 40.0)
        assertThat(result.failedLatency.count).isZero()
        assertThat(result.services.getValue("entry").timeouts).isZero()
        assertDrained(rig)
    }

    @Test
    fun `capped timeout without response at deadline keeps deadline outcome`() {
        val rig =
            simulate(
                chain =
                    chain(
                        backendProcessingMs = 80.0,
                        timeoutMs = 500.0,
                        attempts = 1,
                        requestDeadlineMs = 40.0,
                    ),
                requests = listOf(InvocationSpec()),
                observationTimesMs = listOf(40.5),
                replicationLengthMs = 100.0,
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.DEADLINE_EXCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(40.0, offset(0.0))
        assertThat(attempt!!.timeoutEvent.time).isCloseTo(40.0, offset(0.0))
        assertThat(attempt.status).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(attempt.timeoutEvent.cancel).isFalse()
        assertThat(attempt.child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(attempt.child.work.isCompleted).isTrue()
        assertThat(attempt.child.work.processCompletionTime).isCloseTo(80.0, offset(0.0))

        val result = rig.result()
        assertOriginalFailureOnce(result, 40.0)
        assertThat(result.services.getValue("entry").timeouts).isEqualTo(1)
        assertThat(result.services.getValue("entry").retries).isZero()
        assertThat(rig.observations).containsExactly(
            Snapshot(
                timeMs = 40.5,
                activeInvocations = 1,
                activeOriginalRequests = 0,
                activeDownstreamProcesses = 1,
                entryHandlerBusy = 0,
                backendHandlerBusy = 1,
                originalCompletions = 1,
            ),
        )
        assertDrained(rig)
    }

    @Test
    fun `original deadline is propagated to nested attempt timeouts and orphan drain`() {
        val rig =
            simulate(
                chain = threeServiceChain(),
                requests = listOf(InvocationSpec()),
                replicationLengthMs = 150.0,
            )

        val caller = rig.invocations.single()
        val firstAttempt = caller.callAttempt
        assertThat(firstAttempt).isNotNull()
        val nestedAttempt = firstAttempt!!.child.callAttempt
        assertThat(nestedAttempt).isNotNull()
        assertThat(firstAttempt.timeoutEvent.time).isCloseTo(40.0, offset(0.0))
        assertThat(nestedAttempt!!.timeoutEvent.time).isCloseTo(40.0, offset(0.0))
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.DEADLINE_EXCEEDED)
        assertThat(nestedAttempt.child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(nestedAttempt.child.work.processCompletionTime).isCloseTo(100.0, offset(0.0))
        assertOriginalFailureOnce(rig.result(), 40.0)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .timeouts,
        ).isEqualTo(1)
        assertThat(
            rig
                .result()
                .services
                .getValue("backend")
                .timeouts,
        ).isEqualTo(1)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .retries,
        ).isZero()
        assertThat(
            rig
                .result()
                .services
                .getValue("backend")
                .retries,
        ).isZero()
        assertDrained(rig)
    }

    @Test
    fun `timeout is retried while the orphaned first child still completes`() {
        val rig =
            simulate(
                chain =
                    chain(
                        backendProcessingMs = 5.0,
                        timeoutMs = 6.0,
                        backoff = fixedBackoff(4.0),
                    ),
                requests =
                    listOf(
                        InvocationSpec(originalRequest = false, serviceId = "backend"),
                        InvocationSpec(),
                    ),
                observationTimesMs = listOf(2.0),
                replicationLengthMs = 100.0,
            )

        val caller = rig.invocations[1]
        val firstAttempt = rig.observedAttempts.single()
        assertThat(firstAttempt).isNotNull()
        val secondAttempt = caller.callAttempt
        assertThat(secondAttempt).isNotNull()
        assertThat(secondAttempt).isNotSameAs(firstAttempt)
        assertThat(firstAttempt!!.status).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(firstAttempt.child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(firstAttempt.child.work.processCompletionTime).isCloseTo(10.0, offset(0.0))
        assertThat(secondAttempt!!.child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(secondAttempt.child.work.processCompletionTime).isCloseTo(15.0, offset(0.0))
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertLatencies(rig.result().successfulLatency, 15.0)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .timeouts,
        ).isEqualTo(1)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .retries,
        ).isEqualTo(1)
        assertDrained(rig)
    }

    private fun chain(
        entryProcessingMs: Double = 0.0,
        backendProcessingMs: Double = 0.0,
        entryFailureRate: Double = 0.0,
        backendFailureRate: Double = 0.0,
        backendQueueCapacity: Int = 2,
        timeoutMs: Double = 50.0,
        attempts: Int = 2,
        backoff: Backoff = TestChains.backoff(BackoffKind.NONE, 0.0, 0.0),
        requestDeadlineMs: Double = 500.0,
    ): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                listOf(
                    base.services[0].copy(
                        processing = fixed(entryProcessingMs),
                        failureProbability = entryFailureRate,
                    ),
                    base.services[1].copy(
                        processing = fixed(backendProcessingMs),
                        failureProbability = backendFailureRate,
                        queueCapacity = backendQueueCapacity,
                    ),
                ),
            calls =
                listOf(
                    base.calls.single().copy(
                        timeoutMs = timeoutMs,
                        attempts = attempts,
                        backoff = backoff,
                    ),
                ),
            client = base.client.copy(deadlineMs = requestDeadlineMs),
        )
    }

    private fun threeServiceChain(): GraphIr {
        val base = chain(timeoutMs = 500.0, requestDeadlineMs = 40.0)
        val third = base.services[1].copy(pathSegments = listOf("third"), processing = fixed(100.0))
        val secondLink =
            base.calls.single().copy(
                pathSegments = listOf("backend-to-third"),
                from = "backend",
                to = "third",
            )
        return base.copy(
            services = base.services + third,
            calls = base.calls + secondLink,
        )
    }

    private fun fixedBackoff(durationMs: Double): Backoff = TestChains.fixedBackoff(durationMs)

    private fun fixed(durationMs: Double): Distribution = TestChains.fixed(durationMs)

    /** First seed from 42 whose backend fails the first local attempt and succeeds the second at failure probability 0.5. */
    private fun failureThenSuccessSeed(): Long {
        var candidate = 42L
        while (true) {
            val outcomes = TestChains.stream(candidate, "backend", StreamRole.OUTCOME)
            if (outcomes.randU01() < 0.5 && outcomes.randU01() >= 0.5) return candidate
            candidate++
        }
    }

    private fun simulate(
        chain: GraphIr,
        requests: List<InvocationSpec>,
        observationTimesMs: List<Double> = emptyList(),
        replicationLengthMs: Double = 200.0,
        seed: Long = 42L,
    ): SimulationRig {
        val model = Model("RetryDeadlineTest", autoCSVReports = false)
        val reliabilityModel = TestChains.reliabilityModel(model, chain.copy(run = execution(seed)))
        val driver = InvocationDriver(model, reliabilityModel, requests, observationTimesMs)
        model.numberOfReplications = 1
        model.lengthOfReplication = replicationLengthMs
        model.simulate()
        return SimulationRig(model, reliabilityModel, driver)
    }

    private fun execution(seed: Long): RunSettings =
        RunSettings(
            replications = 1,
            warmupMs = 0.0,
            measurementMs = 1_000.0,
            seed = seed,
            maxRealTimeSeconds = 30L,
        )

    private fun assertOriginalFailureOnce(
        result: ReplicationResult,
        latencyMs: Double,
    ) {
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isZero()
        assertThat(result.failures).isEqualTo(1)
        assertLatencies(result.allLatency, latencyMs)
        assertThat(result.successfulLatency.count).isZero()
        assertLatencies(result.failedLatency, latencyMs)
    }

    private fun assertDrained(rig: SimulationRig) {
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
        assertThat(rig.reliabilityModel.activeDownstreamProcesses).isZero()
        assertThat(rig.handlerBusy("entry")).isZero()
        assertThat(rig.handlerBusy("backend")).isZero()
    }

    private data class InvocationSpec(
        val arrivalTimeMs: Double = 0.0,
        val originalRequest: Boolean = true,
        val serviceId: String = "entry",
    )

    private data class Snapshot(
        val timeMs: Double,
        val activeInvocations: Int,
        val activeOriginalRequests: Int,
        val activeDownstreamProcesses: Int,
        val entryHandlerBusy: Int,
        val backendHandlerBusy: Int,
        val originalCompletions: Int,
    )

    private class SimulationRig(
        private val model: Model,
        val reliabilityModel: ReliabilityModel,
        private val driver: InvocationDriver,
    ) {
        val invocations: List<ReliabilityModel.ServiceInvocation>
            get() = driver.created
        val observations: List<Snapshot>
            get() = driver.observations
        val observedAttempts: List<CallAttempt?>
            get() = driver.observedAttempts

        fun result(): ReplicationResult = reliabilityModel.metrics.replicationResult()

        fun handlerBusy(serviceId: String): Int = (model.getModelElement(serviceId) as ResourceWithQ).numBusy
    }

    private class InvocationDriver(
        model: Model,
        private val reliabilityModel: ReliabilityModel,
        private val requests: List<InvocationSpec>,
        private val observationTimesMs: List<Double>,
    ) : ProcessModel(model) {
        val created = mutableListOf<ReliabilityModel.ServiceInvocation>()
        val observations = mutableListOf<Snapshot>()
        val observedAttempts = mutableListOf<CallAttempt?>()

        override fun initialize() {
            created.clear()
            observations.clear()
            observedAttempts.clear()
            requests.forEach { request ->
                created +=
                    reliabilityModel.invoke(
                        serviceId = request.serviceId,
                        timeUntilActivation = request.arrivalTimeMs,
                        originalRequest = request.originalRequest,
                    )
            }
            observationTimesMs.forEach { observationTime ->
                activate(Observation().work, observationTime)
            }
        }

        private inner class Observation : Entity() {
            val work =
                process("observe-retry-deadline") {
                    val result = reliabilityModel.metrics.replicationResult()
                    observations +=
                        Snapshot(
                            timeMs = time,
                            activeInvocations = reliabilityModel.activeInvocations,
                            activeOriginalRequests = reliabilityModel.activeOriginalRequests,
                            activeDownstreamProcesses = reliabilityModel.activeDownstreamProcesses,
                            entryHandlerBusy = (model.getModelElement("entry") as ResourceWithQ).numBusy,
                            backendHandlerBusy = (model.getModelElement("backend") as ResourceWithQ).numBusy,
                            originalCompletions = result.allLatency.count.toInt(),
                        )
                    observedAttempts += created.lastOrNull()?.callAttempt
                }
        }
    }
}
