package io.github.chernetsovng.resiliencelab.core.simulation

import io.github.chernetsovng.resiliencelab.core.experiment.ReplicationResult
import io.github.chernetsovng.resiliencelab.core.scenario.DistributionKind
import io.github.chernetsovng.resiliencelab.core.scenario.DurationDistribution
import io.github.chernetsovng.resiliencelab.core.scenario.Execution
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import io.github.chernetsovng.resiliencelab.core.scenario.TestData
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TimeoutRaceTest {
    @Test
    fun `same-time response wins and cancels the timeout`() {
        val rig = simulate(
            scenario = scenario(entryProcessingMs = 0.0, backendProcessingMs = 50.0, timeoutMs = 50.0),
            requests = listOf(InvocationSpec()),
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        val child = attempt.child
        assertEquals(AttemptOutcome.SUCCEEDED, caller.outcome)
        assertEquals(50.0, caller.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.SUCCEEDED, attempt.status)
        assertEquals(AttemptOutcome.SUCCEEDED, child.outcome)
        assertEquals(50.0, child.work.processCompletionTime, 0.0)
        assertEquals(50.0, attempt.timeoutEvent.time, 0.0)
        assertEquals(KSLEvent.DEFAULT_PRIORITY + 1, attempt.timeoutEvent.priority)
        assertTrue(attempt.timeoutEvent.cancel)
        assertFalse(attempt.timeoutEvent.isScheduled)
        assertEquals(0, rig.result().services.getValue("entry").timeouts)
        assertEquals(listOf(50.0), rig.result().successfulLatenciesMs)
        assertEquals(0, rig.handlerBusy("entry"))
        assertEquals(0, rig.handlerBusy("backend"))
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
    }

    @Test
    fun `caller times out at 50 while orphaned downstream succeeds at 80`() {
        val rig = simulate(
            scenario = scenario(entryProcessingMs = 0.0, backendProcessingMs = 80.0, timeoutMs = 50.0),
            requests = listOf(InvocationSpec()),
            observationTimesMs = listOf(25.0, 50.5, 79.5, 80.5),
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        val child = attempt.child
        assertEquals(AttemptOutcome.TIMED_OUT, caller.outcome)
        assertEquals(50.0, caller.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.TIMED_OUT, attempt.status)
        assertEquals(AttemptOutcome.SUCCEEDED, child.outcome)
        assertEquals(80.0, child.work.processCompletionTime, 0.0)
        assertTrue(child.work.isCompleted)
        assertFalse(child.work.isTerminated)
        assertTrue(child.isProcessEnded)
        assertFalse(attempt.timeoutEvent.cancel)
        assertEquals(
            listOf(
                Snapshot(25.0, 2, 1, 1, 1, 1, 1, 1),
                Snapshot(50.5, 1, 0, 0, 1, 1, 1, 1),
                Snapshot(79.5, 1, 0, 0, 1, 1, 1, 1),
                Snapshot(80.5, 0, 0, 0, 0, 1, 1, 1),
            ),
            rig.observations,
        )

        val result = rig.result()
        assertEquals(listOf(0.0), result.arrivalTimesMs)
        assertEquals(listOf(50.0), result.allLatenciesMs)
        assertEquals(emptyList(), result.successfulLatenciesMs)
        assertEquals(listOf(50.0), result.failedLatenciesMs)
        assertEquals(1, result.originalArrivals)
        assertEquals(0, result.successes)
        assertEquals(1, result.failures)
        assertEquals(1, result.services.getValue("entry").offeredAttempts)
        assertEquals(1, result.services.getValue("entry").admittedAttempts)
        assertEquals(1, result.services.getValue("entry").timeouts)
        assertEquals(1, result.services.getValue("backend").offeredAttempts)
        assertEquals(1, result.services.getValue("backend").admittedAttempts)
        assertEquals(0, result.services.getValue("backend").timeouts)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
    }

    @Test
    fun `independent nonzero request and response samples are inside the attempt timeout`() {
        val networkMeanMs = 5.0
        val (requestDelayMs, responseDelayMs) = networkSamples(networkMeanMs)
        assertTrue(requestDelayMs > 0.0)
        assertTrue(responseDelayMs > 0.0)
        assertNotEquals(requestDelayMs, responseDelayMs)
        val expectedCompletionMs = requestDelayMs + 10.0 + responseDelayMs
        assertTrue(expectedCompletionMs < 500.0)

        val rig = simulate(
            scenario = scenario(
                entryProcessingMs = 0.0,
                backendProcessingMs = 10.0,
                network = DurationDistribution(DistributionKind.EXPONENTIAL, networkMeanMs, stdDevMs = null),
                timeoutMs = 500.0,
            ),
            requests = listOf(InvocationSpec()),
            observationTimesMs = listOf(
                requestDelayMs / 2.0,
                requestDelayMs + 10.0 + responseDelayMs / 2.0,
            ),
            replicationLengthMs = 1_000.0,
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        val child = attempt.child
        assertEquals(0.0, child.work.processStartTime, 0.0)
        assertEquals(expectedCompletionMs, child.work.processCompletionTime, 1e-9)
        assertEquals(expectedCompletionMs, caller.work.processCompletionTime, 1e-9)
        assertEquals(AttemptOutcome.SUCCEEDED, child.outcome)
        assertEquals(AttemptOutcome.SUCCEEDED, caller.outcome)
        assertEquals(AttemptOutcome.SUCCEEDED, attempt.status)
        assertEquals(listOf(expectedCompletionMs), rig.result().allLatenciesMs)
        assertEquals(0, rig.result().services.getValue("entry").timeouts)
        assertTrue(attempt.timeoutEvent.cancel)
        assertEquals(
            listOf(
                Snapshot(requestDelayMs / 2.0, 1, 1, 1, 0, 1, 0, 0),
                Snapshot(requestDelayMs + 10.0 + responseDelayMs / 2.0, 2, 1, 1, 0, 1, 1, 1),
            ),
            rig.observations,
        )
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.handlerBusy("entry"))
        assertEquals(0, rig.handlerBusy("backend"))
    }

    @Test
    fun `caller queue and one local preprocessing are outside the attempt timeout`() {
        val rig = simulate(
            scenario = scenario(entryProcessingMs = 30.0, backendProcessingMs = 50.0, timeoutMs = 50.0),
            requests = listOf(
                InvocationSpec(originalRequest = false),
                InvocationSpec(originalRequest = true),
            ),
            observationTimesMs = listOf(50.5, 80.5, 110.5, 160.5),
            replicationLengthMs = 200.0,
        )

        val first = rig.invocations[0]
        val second = rig.invocations[1]
        val firstAttempt = assertNotNull(first.callAttempt)
        val secondAttempt = assertNotNull(second.callAttempt)
        assertEquals(AttemptOutcome.SUCCEEDED, first.outcome)
        assertEquals(80.0, first.work.processCompletionTime, 0.0)
        assertEquals(80.0, firstAttempt.timeoutEvent.time, 0.0)
        assertEquals(AttemptOutcome.SUCCEEDED, second.outcome)
        assertEquals(160.0, second.work.processCompletionTime, 0.0)
        assertEquals(160.0, secondAttempt.timeoutEvent.time, 0.0)
        assertEquals(160.0, secondAttempt.child.work.processCompletionTime, 0.0)
        assertTrue(secondAttempt.timeoutEvent.cancel)
        assertEquals(
            listOf(
                Snapshot(50.5, 3, 1, 1, 1, 2, 1, 1),
                Snapshot(80.5, 1, 1, 1, 0, 2, 1, 1),
                Snapshot(110.5, 2, 1, 1, 1, 2, 2, 2),
                Snapshot(160.5, 0, 0, 0, 0, 2, 2, 2),
            ),
            rig.observations,
        )

        val result = rig.result()
        assertEquals(listOf(0.0), result.arrivalTimesMs)
        assertEquals(listOf(160.0), result.allLatenciesMs)
        assertEquals(listOf(160.0), result.successfulLatenciesMs)
        assertEquals(1, result.originalArrivals)
        assertEquals(1, result.successes)
        assertEquals(0, result.failures)
        assertEquals(0, result.services.getValue("entry").timeouts)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
    }

    @Test
    fun `response before the deadline cancels the scheduled timeout`() {
        val rig = simulate(
            scenario = scenario(
                entryProcessingMs = 0.0,
                backendProcessingMs = 20.0,
                network = fixed(5.0),
                timeoutMs = 50.0,
            ),
            requests = listOf(InvocationSpec()),
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        assertEquals(AttemptOutcome.SUCCEEDED, caller.outcome)
        assertEquals(30.0, caller.work.processCompletionTime, 0.0)
        assertEquals(30.0, attempt.child.work.processCompletionTime, 0.0)
        assertEquals(50.0, attempt.timeoutEvent.time, 0.0)
        assertTrue(attempt.timeoutEvent.cancel)
        assertFalse(attempt.timeoutEvent.isScheduled)
        assertEquals(0, rig.result().services.getValue("entry").timeouts)
        assertEquals(listOf(30.0), rig.result().successfulLatenciesMs)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.handlerBusy("entry"))
        assertEquals(0, rig.handlerBusy("backend"))
    }

    @Test
    fun `timeout expires while the response network is still in flight`() {
        val rig = simulate(
            scenario = scenario(
                entryProcessingMs = 0.0,
                backendProcessingMs = 10.0,
                network = fixed(5.0),
                timeoutMs = 18.0,
            ),
            requests = listOf(InvocationSpec()),
            observationTimesMs = listOf(14.5, 16.0, 18.5, 20.5),
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        val child = attempt.child
        assertEquals(AttemptOutcome.TIMED_OUT, caller.outcome)
        assertEquals(18.0, caller.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.TIMED_OUT, attempt.status)
        assertEquals(AttemptOutcome.SUCCEEDED, child.outcome)
        assertEquals(20.0, child.work.processCompletionTime, 0.0)
        assertTrue(child.work.isCompleted)
        assertFalse(child.work.isTerminated)
        assertFalse(attempt.timeoutEvent.cancel)
        assertEquals(
            listOf(
                Snapshot(14.5, 2, 1, 1, 1, 1, 1, 1),
                Snapshot(16.0, 2, 1, 1, 0, 1, 1, 1),
                Snapshot(18.5, 1, 0, 0, 0, 1, 1, 1),
                Snapshot(20.5, 0, 0, 0, 0, 1, 1, 1),
            ),
            rig.observations,
        )
        assertEquals(listOf(18.0), rig.result().failedLatenciesMs)
        assertEquals(1, rig.result().services.getValue("entry").timeouts)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
    }

    @Test
    fun `downstream process remains live after caller timeout during request network`() {
        val rig = simulate(
            scenario = scenario(
                entryProcessingMs = 0.0,
                backendProcessingMs = 5.0,
                network = fixed(20.0),
                timeoutMs = 10.0,
            ),
            requests = listOf(InvocationSpec()),
            observationTimesMs = listOf(10.5, 20.5, 30.5, 45.5),
        )

        val caller = rig.invocations.single()
        val attempt = assertNotNull(caller.callAttempt)
        val child = attempt.child
        assertEquals(AttemptOutcome.TIMED_OUT, caller.outcome)
        assertEquals(10.0, caller.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.SUCCEEDED, child.outcome)
        assertEquals(45.0, child.work.processCompletionTime, 0.0)
        assertTrue(child.work.isCompleted)
        assertFalse(child.work.isTerminated)
        assertEquals(
            listOf(
                LivenessSnapshot(10.5, 0, 0, 1),
                LivenessSnapshot(20.5, 1, 0, 1),
                LivenessSnapshot(30.5, 1, 0, 1),
                LivenessSnapshot(45.5, 0, 0, 0),
            ),
            rig.livenessObservations,
        )

        val result = rig.result()
        assertEquals(listOf(10.0), result.failedLatenciesMs)
        assertEquals(1, result.services.getValue("entry").timeouts)
        assertEquals(1, result.services.getValue("backend").offeredAttempts)
        assertEquals(1, result.services.getValue("backend").admittedAttempts)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
        assertEquals(0, rig.reliabilityModel.activeDownstreamProcesses)
    }

    @Test
    fun `never admitted orphan remains live throughout its response network`() {
        val rig = simulate(
            scenario = scenario(
                entryProcessingMs = 0.0,
                backendProcessingMs = 30.0,
                network = fixed(20.0),
                timeoutMs = 10.0,
                backendQueueCapacity = 0,
            ),
            requests = listOf(
                InvocationSpec(originalRequest = false, serviceId = "backend"),
                InvocationSpec(),
            ),
            observationTimesMs = listOf(10.5, 20.5, 30.5, 40.5),
        )

        val blocker = rig.invocations[0]
        val caller = rig.invocations[1]
        val attempt = assertNotNull(caller.callAttempt)
        val child = attempt.child
        assertEquals(AttemptOutcome.SUCCEEDED, blocker.outcome)
        assertEquals(30.0, blocker.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.TIMED_OUT, caller.outcome)
        assertEquals(10.0, caller.work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.QUEUE_REJECTED, child.outcome)
        assertEquals(40.0, child.work.processCompletionTime, 0.0)
        assertTrue(child.work.isCompleted)
        assertFalse(child.work.isTerminated)
        assertEquals(
            listOf(
                LivenessSnapshot(10.5, 1, 0, 1),
                LivenessSnapshot(20.5, 1, 0, 1),
                LivenessSnapshot(30.5, 0, 0, 1),
                LivenessSnapshot(40.5, 0, 0, 0),
            ),
            rig.livenessObservations,
        )

        val result = rig.result()
        assertEquals(listOf(10.0), result.failedLatenciesMs)
        assertEquals(1, result.services.getValue("entry").timeouts)
        assertEquals(2, result.services.getValue("backend").offeredAttempts)
        assertEquals(1, result.services.getValue("backend").admittedAttempts)
        assertEquals(1, result.services.getValue("backend").queueRejections)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
        assertEquals(0, rig.reliabilityModel.activeDownstreamProcesses)
        assertEquals(0, rig.handlerBusy("entry"))
        assertEquals(0, rig.handlerBusy("backend"))
    }

    private fun networkSamples(meanMs: Double): Pair<Double, Double> {
        val provider = RNStreamProvider().apply {
            initialSeed(SeedFactory.seedVector(42L))
        }
        val samples = ExponentialRV(meanMs, streamNum = 5, streamProvider = provider)
        return samples.value to samples.value
    }

    private fun scenario(
        entryProcessingMs: Double,
        backendProcessingMs: Double,
        network: DurationDistribution = fixed(0.0),
        timeoutMs: Double,
        backendQueueCapacity: Int? = null,
    ): Scenario {
        val base = TestData.simpleScenario()
        return base.copy(
            services = listOf(
                base.services[0].copy(processing = fixed(entryProcessingMs)),
                base.services[1].copy(
                    processing = fixed(backendProcessingMs),
                    queueCapacity = backendQueueCapacity ?: base.services[1].queueCapacity,
                ),
            ),
            links = listOf(
                base.links.single().copy(network = network, timeoutMs = timeoutMs),
            ),
        )
    }

    private fun fixed(durationMs: Double): DurationDistribution = DurationDistribution(
        kind = DistributionKind.FIXED,
        meanMs = durationMs,
        stdDevMs = null,
    )

    private fun simulate(
        scenario: Scenario,
        requests: List<InvocationSpec>,
        observationTimesMs: List<Double> = emptyList(),
        replicationLengthMs: Double = 100.0,
    ): SimulationRig {
        val model = Model("TimeoutRaceTest", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, scenario, execution())
        val driver = InvocationDriver(model, reliabilityModel, requests, observationTimesMs)
        model.numberOfReplications = 1
        model.lengthOfReplication = replicationLengthMs
        model.simulate()
        return SimulationRig(model, reliabilityModel, driver)
    }

    private fun execution(): Execution = Execution(
        replications = 1,
        warmupMs = 0.0,
        measurementMs = 1_000.0,
        seed = 42L,
        maxRealTimeSeconds = 30L,
    )

    private data class InvocationSpec(
        val arrivalTimeMs: Double = 0.0,
        val originalRequest: Boolean = true,
        val serviceId: String = "entry",
    )

    private data class Snapshot(
        val timeMs: Double,
        val activeInvocations: Int,
        val activeOriginalRequests: Int,
        val entryHandlerBusy: Int,
        val backendHandlerBusy: Int,
        val entryOffered: Int,
        val backendOffered: Int,
        val backendAdmitted: Int,
    )

    private data class LivenessSnapshot(
        val timeMs: Double,
        val activeInvocations: Int,
        val activeOriginalRequests: Int,
        val activeDownstreamProcesses: Int,
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
        val livenessObservations: List<LivenessSnapshot>
            get() = driver.livenessObservations

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
        val livenessObservations = mutableListOf<LivenessSnapshot>()

        override fun initialize() {
            created.clear()
            observations.clear()
            livenessObservations.clear()
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
            val work = process("observe-timeout-race") {
                val result = reliabilityModel.metrics.replicationResult()
                observations += Snapshot(
                    timeMs = time,
                    activeInvocations = reliabilityModel.activeInvocations,
                    activeOriginalRequests = reliabilityModel.activeOriginalRequests,
                    entryHandlerBusy = (model.getModelElement("entry") as ResourceWithQ).numBusy,
                    backendHandlerBusy = (model.getModelElement("backend") as ResourceWithQ).numBusy,
                    entryOffered = result.services.getValue("entry").offeredAttempts,
                    backendOffered = result.services.getValue("backend").offeredAttempts,
                    backendAdmitted = result.services.getValue("backend").admittedAttempts,
                )
                livenessObservations += LivenessSnapshot(
                    timeMs = time,
                    activeInvocations = reliabilityModel.activeInvocations,
                    activeOriginalRequests = reliabilityModel.activeOriginalRequests,
                    activeDownstreamProcesses = reliabilityModel.activeDownstreamProcesses,
                )
            }
        }
    }
}
