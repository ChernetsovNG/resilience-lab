package io.github.chernetsovng.resiliencelab.core.simulation

import io.github.chernetsovng.resiliencelab.core.experiment.ReplicationResult
import io.github.chernetsovng.resiliencelab.core.scenario.DistributionKind
import io.github.chernetsovng.resiliencelab.core.scenario.DurationDistribution
import io.github.chernetsovng.resiliencelab.core.scenario.Execution
import io.github.chernetsovng.resiliencelab.core.scenario.RetryKind
import io.github.chernetsovng.resiliencelab.core.scenario.RetrySpec
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import io.github.chernetsovng.resiliencelab.core.scenario.TestData
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.UniformRV
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RetryDeadlineTest {
    @Test
    fun `none backoff is zero without sampling jitter`() {
        val retry = RetrySpec(RetryKind.NONE, 100.0, 7_000.0, base = 3.0)
        var jitterSampled = false

        val delayMs = RetryPolicyEvaluator.backoffMs(retry, failedAttemptNumber = 1) {
            jitterSampled = true
            0.999
        }

        assertEquals(0.0, delayMs, 0.0)
        assertFalse(jitterSampled)
    }

    @Test
    fun `fixed backoff is the minimum of base and cap`() {
        val belowCap = RetrySpec(RetryKind.FIXED, 100.0, 7_000.0, base = 3.0)
        val aboveCap = belowCap.copy(maxBackoffMs = 50.0)

        assertEquals(100.0, RetryPolicyEvaluator.backoffMs(belowCap, 1) { 0.999 }, 0.0)
        assertEquals(50.0, RetryPolicyEvaluator.backoffMs(aboveCap, 4) { 0.999 }, 0.0)
    }

    @Test
    fun `exponential backoff uses configurable base three and the cap`() {
        val retry = RetrySpec(RetryKind.EXPONENTIAL_FULL_JITTER, 100.0, 7_000.0, base = 3.0)

        val delaysMs = (1..6).map { failedAttempt ->
            RetryPolicyEvaluator.backoffMs(retry, failedAttempt) { 1.0 }
        }

        assertEquals(listOf(100.0, 300.0, 900.0, 2700.0, 7000.0, 7000.0), delaysMs)
    }

    @Test
    fun `full jitter scales the capped exponential delay`() {
        val retry = RetrySpec(RetryKind.EXPONENTIAL_FULL_JITTER, 100.0, 7_000.0, base = 3.0)

        val zero = RetryPolicyEvaluator.backoffMs(retry, failedAttemptNumber = 5) { 0.0 }
        val almostCap = RetryPolicyEvaluator.backoffMs(retry, failedAttemptNumber = 5) { 0.999 }

        assertEquals(0.0, zero, 0.0)
        assertEquals(6_993.0, almostCap, 1e-9)
        assertTrue(almostCap in 0.0..7_000.0)
    }

    @Test
    fun `queue rejection is retried with a fresh child and then succeeds`() {
        val rig = simulate(
            scenario = scenario(
                backendProcessingMs = 10.0,
                backendQueueCapacity = 0,
                retry = fixedBackoff(20.0),
            ),
            requests = listOf(
                InvocationSpec(originalRequest = false, serviceId = "backend"),
                InvocationSpec(),
            ),
            observationTimesMs = listOf(10.0),
        )

        val caller = rig.invocations[1]
        val firstAttempt = assertNotNull(rig.observedAttempts.single())
        val secondAttempt = assertNotNull(caller.callAttempt)
        assertNotSame(firstAttempt, secondAttempt)
        assertNotSame(firstAttempt.child, secondAttempt.child)
        assertEquals(AttemptOutcome.QUEUE_REJECTED, firstAttempt.child.outcome)
        assertEquals(AttemptOutcome.SUCCEEDED, secondAttempt.child.outcome)
        assertEquals(AttemptOutcome.SUCCEEDED, caller.outcome)
        assertEquals(30.0, caller.work.processCompletionTime, 0.0)

        val result = rig.result()
        assertEquals(listOf(30.0), result.successfulLatenciesMs)
        assertEquals(1, result.services.getValue("entry").retries)
        assertEquals(3, result.services.getValue("backend").offeredAttempts)
        assertEquals(2, result.services.getValue("backend").admittedAttempts)
        assertEquals(1, result.services.getValue("backend").queueRejections)
        assertDrained(rig)
    }

    @Test
    fun `downstream local failure is retryable`() {
        val rig = simulate(
            scenario = scenario(backendFailureRate = 0.5),
            requests = listOf(InvocationSpec()),
            seed = failureThenSuccessSeed(),
        )

        val caller = rig.invocations.single()
        assertEquals(AttemptOutcome.SUCCEEDED, caller.outcome)
        assertEquals(0.0, caller.work.processCompletionTime, 0.0)
        val result = rig.result()
        assertEquals(listOf(0.0), result.successfulLatenciesMs)
        assertEquals(2, result.services.getValue("backend").offeredAttempts)
        assertEquals(2, result.services.getValue("backend").admittedAttempts)
        assertEquals(1, result.services.getValue("backend").failures)
        assertEquals(1, result.services.getValue("entry").retries)
        assertDrained(rig)
    }

    @Test
    fun `five max attempts means five total attempts and four retries`() {
        val rig = simulate(
            scenario = scenario(backendFailureRate = 1.0, maxAttempts = 5),
            requests = listOf(InvocationSpec()),
        )

        val caller = rig.invocations.single()
        assertEquals(AttemptOutcome.DOWNSTREAM_FAILURE, caller.outcome)
        val result = rig.result()
        assertEquals(5, result.services.getValue("backend").offeredAttempts)
        assertEquals(5, result.services.getValue("backend").admittedAttempts)
        assertEquals(5, result.services.getValue("backend").failures)
        assertEquals(4, result.services.getValue("entry").retries)
        assertEquals(0, result.services.getValue("backend").retries)
        assertEquals(listOf(0.0), result.failedLatenciesMs)
        assertDrained(rig)
    }

    @Test
    fun `caller handler stays allocated during backoff while a second request waits`() {
        val rig = simulate(
            scenario = scenario(
                backendProcessingMs = 10.0,
                backendQueueCapacity = 0,
                retry = fixedBackoff(20.0),
            ),
            requests = listOf(
                InvocationSpec(originalRequest = false, serviceId = "backend"),
                InvocationSpec(),
                InvocationSpec(arrivalTimeMs = 5.0),
            ),
            observationTimesMs = listOf(10.5),
        )

        assertEquals(
            listOf(
                Snapshot(
                    timeMs = 10.5,
                    activeInvocations = 2,
                    activeOriginalRequests = 2,
                    activeDownstreamProcesses = 0,
                    entryHandlerBusy = 1,
                    backendHandlerBusy = 0,
                    originalCompletions = 0,
                ),
            ),
            rig.observations,
        )
        assertEquals(30.0, rig.invocations[1].work.processCompletionTime, 0.0)
        assertEquals(40.0, rig.invocations[2].work.processCompletionTime, 0.0)
        assertEquals(listOf(30.0, 35.0), rig.result().successfulLatenciesMs)
        assertEquals(1, rig.result().services.getValue("entry").retries)
        assertDrained(rig)
    }

    @Test
    fun `deadline during backoff prevents another attempt and completes the client once`() {
        val rig = simulate(
            scenario = scenario(
                backendProcessingMs = 100.0,
                backendQueueCapacity = 0,
                maxAttempts = 5,
                retry = fixedBackoff(100.0),
                requestDeadlineMs = 50.0,
            ),
            requests = listOf(
                InvocationSpec(originalRequest = false, serviceId = "backend"),
                InvocationSpec(),
            ),
            observationTimesMs = listOf(50.5),
            replicationLengthMs = 150.0,
        )

        val caller = rig.invocations[1]
        assertEquals(AttemptOutcome.DEADLINE_EXCEEDED, caller.outcome)
        assertEquals(50.0, caller.work.processCompletionTime, 0.0)
        assertEquals(2, rig.result().services.getValue("backend").offeredAttempts)
        assertEquals(0, rig.result().services.getValue("entry").retries)
        assertOriginalFailureOnce(rig.result(), 50.0)
        assertEquals(
            listOf(
                Snapshot(
                    timeMs = 50.5,
                    activeInvocations = 1,
                    activeOriginalRequests = 0,
                    activeDownstreamProcesses = 0,
                    entryHandlerBusy = 0,
                    backendHandlerBusy = 1,
                    originalCompletions = 1,
                ),
            ),
            rig.observations,
        )
        assertDrained(rig)
    }

    @Test
    fun `deadline during entry queue leaves queued orphan executing with one client failure`() {
        val rig = simulate(
            scenario = scenario(
                entryProcessingMs = 50.0,
                requestDeadlineMs = 10.0,
            ).copy(links = emptyList()),
            requests = listOf(
                InvocationSpec(originalRequest = false),
                InvocationSpec(),
            ),
            observationTimesMs = listOf(10.5, 50.5),
            replicationLengthMs = 150.0,
        )

        val orphanedOriginal = rig.invocations[1]
        assertEquals(AttemptOutcome.DEADLINE_EXCEEDED, orphanedOriginal.outcome)
        assertTrue(orphanedOriginal.work.isCompleted)
        assertEquals(100.0, orphanedOriginal.work.processCompletionTime, 0.0)
        assertOriginalFailureOnce(rig.result(), 10.0)
        assertEquals(2, rig.result().services.getValue("entry").offeredAttempts)
        assertEquals(2, rig.result().services.getValue("entry").admittedAttempts)
        assertEquals(
            listOf(
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
            ),
            rig.observations,
        )
        assertDrained(rig)
    }

    @Test
    fun `deadline during local processing drains accepted work without starting downstream`() {
        val rig = simulate(
            scenario = scenario(
                entryProcessingMs = 50.0,
                requestDeadlineMs = 10.0,
                timeoutMs = 500.0,
            ),
            requests = listOf(InvocationSpec()),
            observationTimesMs = listOf(10.5),
            replicationLengthMs = 100.0,
        )

        val caller = rig.invocations.single()
        assertEquals(AttemptOutcome.DEADLINE_EXCEEDED, caller.outcome)
        assertTrue(caller.work.isCompleted)
        assertEquals(50.0, caller.work.processCompletionTime, 0.0)
        assertNull(caller.callAttempt)
        assertEquals(0, rig.result().services.getValue("backend").offeredAttempts)
        assertOriginalFailureOnce(rig.result(), 10.0)
        assertEquals(
            listOf(
                Snapshot(
                    timeMs = 10.5,
                    activeInvocations = 1,
                    activeOriginalRequests = 0,
                    activeDownstreamProcesses = 0,
                    entryHandlerBusy = 1,
                    backendHandlerBusy = 0,
                    originalCompletions = 1,
                ),
            ),
            rig.observations,
        )
        assertDrained(rig)
    }

    @Test
    fun `response at capped timeout and original deadline wins once without timeout`() {
        val rig = simulate(
            scenario = scenario(
                backendProcessingMs = 40.0,
                timeoutMs = 500.0,
                maxAttempts = 1,
                requestDeadlineMs = 40.0,
            ),
            requests = listOf(InvocationSpec()),
            replicationLengthMs = 100.0,
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        assertEquals(40.0, attempt.timeoutEvent.time, 0.0)
        assertEquals(40.0, attempt.child.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.SUCCEEDED, attempt.status)
        assertTrue(attempt.timeoutEvent.cancel)
        assertFalse(attempt.timeoutEvent.isScheduled)
        assertEquals(AttemptOutcome.SUCCEEDED, caller.outcome)
        assertEquals(40.0, caller.work.processCompletionTime, 0.0)

        val result = rig.result()
        assertEquals(1, result.originalArrivals)
        assertEquals(1, result.successes)
        assertEquals(0, result.failures)
        assertEquals(listOf(40.0), result.allLatenciesMs)
        assertEquals(listOf(40.0), result.successfulLatenciesMs)
        assertEquals(emptyList(), result.failedLatenciesMs)
        assertEquals(0, result.services.getValue("entry").timeouts)
        assertDrained(rig)
    }

    @Test
    fun `capped timeout without response at deadline keeps deadline outcome`() {
        val rig = simulate(
            scenario = scenario(
                backendProcessingMs = 80.0,
                timeoutMs = 500.0,
                maxAttempts = 1,
                requestDeadlineMs = 40.0,
            ),
            requests = listOf(InvocationSpec()),
            observationTimesMs = listOf(40.5),
            replicationLengthMs = 100.0,
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        assertEquals(AttemptOutcome.DEADLINE_EXCEEDED, caller.outcome)
        assertEquals(40.0, caller.work.processCompletionTime, 0.0)
        assertEquals(40.0, attempt.timeoutEvent.time, 0.0)
        assertEquals(AttemptOutcome.TIMED_OUT, attempt.status)
        assertFalse(attempt.timeoutEvent.cancel)
        assertEquals(AttemptOutcome.SUCCEEDED, attempt.child.outcome)
        assertTrue(attempt.child.work.isCompleted)
        assertEquals(80.0, attempt.child.work.processCompletionTime, 0.0)

        val result = rig.result()
        assertOriginalFailureOnce(result, 40.0)
        assertEquals(1, result.services.getValue("entry").timeouts)
        assertEquals(0, result.services.getValue("entry").retries)
        assertEquals(
            listOf(
                Snapshot(
                    timeMs = 40.5,
                    activeInvocations = 1,
                    activeOriginalRequests = 0,
                    activeDownstreamProcesses = 1,
                    entryHandlerBusy = 0,
                    backendHandlerBusy = 1,
                    originalCompletions = 1,
                ),
            ),
            rig.observations,
        )
        assertDrained(rig)
    }

    @Test
    fun `original deadline is propagated to nested attempt timeouts and orphan drain`() {
        val rig = simulate(
            scenario = threeServiceScenario(),
            requests = listOf(InvocationSpec()),
            replicationLengthMs = 150.0,
        )

        val caller = rig.invocations.single()
        val firstAttempt = assertNotNull(caller.callAttempt)
        val nestedAttempt = assertNotNull(firstAttempt.child.callAttempt)
        assertEquals(40.0, firstAttempt.timeoutEvent.time, 0.0)
        assertEquals(40.0, nestedAttempt.timeoutEvent.time, 0.0)
        assertEquals(AttemptOutcome.DEADLINE_EXCEEDED, caller.outcome)
        assertEquals(AttemptOutcome.SUCCEEDED, nestedAttempt.child.outcome)
        assertEquals(100.0, nestedAttempt.child.work.processCompletionTime, 0.0)
        assertOriginalFailureOnce(rig.result(), 40.0)
        assertEquals(1, rig.result().services.getValue("entry").timeouts)
        assertEquals(1, rig.result().services.getValue("backend").timeouts)
        assertEquals(0, rig.result().services.getValue("entry").retries)
        assertEquals(0, rig.result().services.getValue("backend").retries)
        assertDrained(rig)
    }

    @Test
    fun `timeout is retried while the orphaned first child still completes`() {
        val rig = simulate(
            scenario = scenario(
                backendProcessingMs = 5.0,
                timeoutMs = 6.0,
                retry = fixedBackoff(4.0),
            ),
            requests = listOf(
                InvocationSpec(originalRequest = false, serviceId = "backend"),
                InvocationSpec(),
            ),
            observationTimesMs = listOf(2.0),
            replicationLengthMs = 100.0,
        )

        val caller = rig.invocations[1]
        val firstAttempt = assertNotNull(rig.observedAttempts.single())
        val secondAttempt = assertNotNull(caller.callAttempt)
        assertNotSame(firstAttempt, secondAttempt)
        assertEquals(AttemptOutcome.TIMED_OUT, firstAttempt.status)
        assertEquals(AttemptOutcome.SUCCEEDED, firstAttempt.child.outcome)
        assertEquals(10.0, firstAttempt.child.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.SUCCEEDED, secondAttempt.child.outcome)
        assertEquals(15.0, secondAttempt.child.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.SUCCEEDED, caller.outcome)
        assertEquals(listOf(15.0), rig.result().successfulLatenciesMs)
        assertEquals(1, rig.result().services.getValue("entry").timeouts)
        assertEquals(1, rig.result().services.getValue("entry").retries)
        assertDrained(rig)
    }

    private fun scenario(
        entryProcessingMs: Double = 0.0,
        backendProcessingMs: Double = 0.0,
        entryFailureRate: Double = 0.0,
        backendFailureRate: Double = 0.0,
        backendQueueCapacity: Int = 2,
        timeoutMs: Double = 50.0,
        maxAttempts: Int = 2,
        retry: RetrySpec = RetrySpec(RetryKind.NONE, 0.0, 0.0),
        requestDeadlineMs: Double = 500.0,
    ): Scenario {
        val base = TestData.simpleScenario()
        return base.copy(
            services = listOf(
                base.services[0].copy(
                    processing = fixed(entryProcessingMs),
                    failureRate = entryFailureRate,
                ),
                base.services[1].copy(
                    processing = fixed(backendProcessingMs),
                    failureRate = backendFailureRate,
                    queueCapacity = backendQueueCapacity,
                ),
            ),
            links = listOf(
                base.links.single().copy(
                    timeoutMs = timeoutMs,
                    maxAttempts = maxAttempts,
                    retry = retry,
                ),
            ),
            workload = base.workload.copy(requestDeadlineMs = requestDeadlineMs),
        )
    }

    private fun threeServiceScenario(): Scenario {
        val base = scenario(timeoutMs = 500.0, requestDeadlineMs = 40.0)
        val third = base.services[1].copy(id = "third", processing = fixed(100.0))
        val secondLink = base.links.single().copy(
            id = "backend-to-third",
            from = "backend",
            to = "third",
        )
        return base.copy(
            services = base.services + third,
            links = base.links + secondLink,
        )
    }

    private fun fixedBackoff(durationMs: Double): RetrySpec = RetrySpec(
        kind = RetryKind.FIXED,
        baseBackoffMs = durationMs,
        maxBackoffMs = durationMs,
    )

    private fun fixed(durationMs: Double): DurationDistribution = DurationDistribution(
        kind = DistributionKind.FIXED,
        meanMs = durationMs,
        stdDevMs = null,
    )

    private fun failureThenSuccessSeed(): Long {
        var candidate = 42L
        while (true) {
            val provider = RNStreamProvider().apply {
                initialSeed(SeedFactory.seedVector(candidate))
            }
            val samples = UniformRV(0.0, 1.0, streamNum = 4, streamProvider = provider)
            if (samples.value < 0.5 && samples.value >= 0.5) return candidate
            candidate++
        }
    }

    private fun simulate(
        scenario: Scenario,
        requests: List<InvocationSpec>,
        observationTimesMs: List<Double> = emptyList(),
        replicationLengthMs: Double = 200.0,
        seed: Long = 42L,
    ): SimulationRig {
        val model = Model("RetryDeadlineTest", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, scenario, execution(seed))
        val driver = InvocationDriver(model, reliabilityModel, requests, observationTimesMs)
        model.numberOfReplications = 1
        model.lengthOfReplication = replicationLengthMs
        model.simulate()
        return SimulationRig(model, reliabilityModel, driver)
    }

    private fun execution(seed: Long): Execution = Execution(
        replications = 1,
        warmupMs = 0.0,
        measurementMs = 1_000.0,
        seed = seed,
        maxRealTimeSeconds = 30L,
    )

    private fun assertOriginalFailureOnce(result: ReplicationResult, latencyMs: Double) {
        assertEquals(1, result.originalArrivals)
        assertEquals(0, result.successes)
        assertEquals(1, result.failures)
        assertEquals(listOf(latencyMs), result.allLatenciesMs)
        assertEquals(emptyList(), result.successfulLatenciesMs)
        assertEquals(listOf(latencyMs), result.failedLatenciesMs)
    }

    private fun assertDrained(rig: SimulationRig) {
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
        assertEquals(0, rig.reliabilityModel.activeDownstreamProcesses)
        assertEquals(0, rig.handlerBusy("entry"))
        assertEquals(0, rig.handlerBusy("backend"))
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

        fun handlerBusy(serviceId: String): Int =
            (model.getModelElement(serviceId) as ResourceWithQ).numBusy
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
                created += reliabilityModel.invoke(
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
            val work = process("observe-retry-deadline") {
                val result = reliabilityModel.metrics.replicationResult()
                observations += Snapshot(
                    timeMs = time,
                    activeInvocations = reliabilityModel.activeInvocations,
                    activeOriginalRequests = reliabilityModel.activeOriginalRequests,
                    activeDownstreamProcesses = reliabilityModel.activeDownstreamProcesses,
                    entryHandlerBusy = (model.getModelElement("entry") as ResourceWithQ).numBusy,
                    backendHandlerBusy = (model.getModelElement("backend") as ResourceWithQ).numBusy,
                    originalCompletions = result.allLatenciesMs.size,
                )
                observedAttempts += created.lastOrNull()?.callAttempt
            }
        }
    }
}
