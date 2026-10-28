package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.Scenario
import resiliencelab.core.scenario.TestData
import kotlin.test.Test

class TimeoutRaceTest {
    @Test
    fun `same-time response wins and cancels the timeout`() {
        val rig =
            simulate(
                scenario = scenario(entryProcessingMs = 0.0, backendProcessingMs = 50.0, timeoutMs = 50.0),
                requests = listOf(InvocationSpec()),
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        val child = attempt!!.child
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(50.0, offset(0.0))
        assertThat(attempt.status).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(child.work.processCompletionTime).isCloseTo(50.0, offset(0.0))
        assertThat(attempt.timeoutEvent.time).isCloseTo(50.0, offset(0.0))
        assertThat(attempt.timeoutEvent.priority).isEqualTo(KSLEvent.DEFAULT_PRIORITY + 1)
        assertThat(attempt.timeoutEvent.cancel).isTrue()
        assertThat(attempt.timeoutEvent.isScheduled).isFalse()
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .timeouts,
        ).isZero()
        assertThat(rig.result().successfulLatenciesMs).containsExactly(50.0)
        assertThat(rig.handlerBusy("entry")).isZero()
        assertThat(rig.handlerBusy("backend")).isZero()
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
    }

    @Test
    fun `caller times out at 50 while orphaned downstream succeeds at 80`() {
        val rig =
            simulate(
                scenario = scenario(entryProcessingMs = 0.0, backendProcessingMs = 80.0, timeoutMs = 50.0),
                requests = listOf(InvocationSpec()),
                observationTimesMs = listOf(25.0, 50.5, 79.5, 80.5),
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        val child = attempt!!.child
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(caller.work.processCompletionTime).isCloseTo(50.0, offset(0.0))
        assertThat(attempt.status).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(child.work.processCompletionTime).isCloseTo(80.0, offset(0.0))
        assertThat(child.work.isCompleted).isTrue()
        assertThat(child.work.isTerminated).isFalse()
        assertThat(child.isProcessEnded).isTrue()
        assertThat(attempt.timeoutEvent.cancel).isFalse()
        assertThat(rig.observations).containsExactly(
            Snapshot(25.0, 2, 1, 1, 1, 1, 1, 1),
            Snapshot(50.5, 1, 0, 0, 1, 1, 1, 1),
            Snapshot(79.5, 1, 0, 0, 1, 1, 1, 1),
            Snapshot(80.5, 0, 0, 0, 0, 1, 1, 1),
        )

        val result = rig.result()
        assertThat(result.arrivalTimesMs).containsExactly(0.0)
        assertThat(result.allLatenciesMs).containsExactly(50.0)
        assertThat(result.successfulLatenciesMs).isEmpty()
        assertThat(result.failedLatenciesMs).containsExactly(50.0)
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isZero()
        assertThat(result.failures).isEqualTo(1)
        assertThat(result.services.getValue("entry").offeredAttempts).isEqualTo(1)
        assertThat(result.services.getValue("entry").admittedAttempts).isEqualTo(1)
        assertThat(result.services.getValue("entry").timeouts).isEqualTo(1)
        assertThat(result.services.getValue("backend").offeredAttempts).isEqualTo(1)
        assertThat(result.services.getValue("backend").admittedAttempts).isEqualTo(1)
        assertThat(result.services.getValue("backend").timeouts).isZero()
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
    }

    @Test
    fun `independent nonzero request and response samples are inside the attempt timeout`() {
        val networkMeanMs = 5.0
        val (requestDelayMs, responseDelayMs) = networkSamples(networkMeanMs)
        assertThat(requestDelayMs).isPositive()
        assertThat(responseDelayMs).isPositive()
        assertThat(responseDelayMs).isNotEqualTo(requestDelayMs)
        val expectedCompletionMs = requestDelayMs + 10.0 + responseDelayMs
        assertThat(expectedCompletionMs).isLessThan(500.0)

        val rig =
            simulate(
                scenario =
                    scenario(
                        entryProcessingMs = 0.0,
                        backendProcessingMs = 10.0,
                        network = DurationDistribution(DistributionKind.EXPONENTIAL, networkMeanMs, stdDevMs = null),
                        timeoutMs = 500.0,
                    ),
                requests = listOf(InvocationSpec()),
                observationTimesMs =
                    listOf(
                        requestDelayMs / 2.0,
                        requestDelayMs + 10.0 + responseDelayMs / 2.0,
                    ),
                replicationLengthMs = 1_000.0,
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        val child = attempt!!.child
        assertThat(child.work.processStartTime).isCloseTo(0.0, offset(0.0))
        assertThat(child.work.processCompletionTime).isCloseTo(expectedCompletionMs, offset(1e-9))
        assertThat(caller.work.processCompletionTime).isCloseTo(expectedCompletionMs, offset(1e-9))
        assertThat(child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(attempt.status).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(rig.result().allLatenciesMs).containsExactly(expectedCompletionMs)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .timeouts,
        ).isZero()
        assertThat(attempt.timeoutEvent.cancel).isTrue()
        assertThat(rig.observations).containsExactly(
            Snapshot(requestDelayMs / 2.0, 1, 1, 1, 0, 1, 0, 0),
            Snapshot(requestDelayMs + 10.0 + responseDelayMs / 2.0, 2, 1, 1, 0, 1, 1, 1),
        )
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.handlerBusy("entry")).isZero()
        assertThat(rig.handlerBusy("backend")).isZero()
    }

    @Test
    fun `caller queue and one local preprocessing are outside the attempt timeout`() {
        val rig =
            simulate(
                scenario = scenario(entryProcessingMs = 30.0, backendProcessingMs = 50.0, timeoutMs = 50.0),
                requests =
                    listOf(
                        InvocationSpec(originalRequest = false),
                        InvocationSpec(originalRequest = true),
                    ),
                observationTimesMs = listOf(50.5, 80.5, 110.5, 160.5),
                replicationLengthMs = 200.0,
            )

        val first = rig.invocations[0]
        val second = rig.invocations[1]
        val firstAttempt = first.callAttempt
        assertThat(firstAttempt).isNotNull()
        val secondAttempt = second.callAttempt
        assertThat(secondAttempt).isNotNull()
        assertThat(first.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(first.work.processCompletionTime).isCloseTo(80.0, offset(0.0))
        assertThat(firstAttempt!!.timeoutEvent.time).isCloseTo(80.0, offset(0.0))
        assertThat(second.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(second.work.processCompletionTime).isCloseTo(160.0, offset(0.0))
        assertThat(secondAttempt!!.timeoutEvent.time).isCloseTo(160.0, offset(0.0))
        assertThat(secondAttempt.child.work.processCompletionTime).isCloseTo(160.0, offset(0.0))
        assertThat(secondAttempt.timeoutEvent.cancel).isTrue()
        assertThat(rig.observations).containsExactly(
            Snapshot(50.5, 3, 1, 1, 1, 2, 1, 1),
            Snapshot(80.5, 1, 1, 1, 0, 2, 1, 1),
            Snapshot(110.5, 2, 1, 1, 1, 2, 2, 2),
            Snapshot(160.5, 0, 0, 0, 0, 2, 2, 2),
        )

        val result = rig.result()
        assertThat(result.arrivalTimesMs).containsExactly(0.0)
        assertThat(result.allLatenciesMs).containsExactly(160.0)
        assertThat(result.successfulLatenciesMs).containsExactly(160.0)
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isEqualTo(1)
        assertThat(result.failures).isZero()
        assertThat(result.services.getValue("entry").timeouts).isZero()
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
    }

    @Test
    fun `response before the deadline cancels the scheduled timeout`() {
        val rig =
            simulate(
                scenario =
                    scenario(
                        entryProcessingMs = 0.0,
                        backendProcessingMs = 20.0,
                        network = fixed(5.0),
                        timeoutMs = 50.0,
                    ),
                requests = listOf(InvocationSpec()),
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(30.0, offset(0.0))
        assertThat(attempt!!.child.work.processCompletionTime).isCloseTo(30.0, offset(0.0))
        assertThat(attempt.timeoutEvent.time).isCloseTo(50.0, offset(0.0))
        assertThat(attempt.timeoutEvent.cancel).isTrue()
        assertThat(attempt.timeoutEvent.isScheduled).isFalse()
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .timeouts,
        ).isZero()
        assertThat(rig.result().successfulLatenciesMs).containsExactly(30.0)
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.handlerBusy("entry")).isZero()
        assertThat(rig.handlerBusy("backend")).isZero()
    }

    @Test
    fun `timeout expires while the response network is still in flight`() {
        val rig =
            simulate(
                scenario =
                    scenario(
                        entryProcessingMs = 0.0,
                        backendProcessingMs = 10.0,
                        network = fixed(5.0),
                        timeoutMs = 18.0,
                    ),
                requests = listOf(InvocationSpec()),
                observationTimesMs = listOf(14.5, 16.0, 18.5, 20.5),
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        val child = attempt!!.child
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(caller.work.processCompletionTime).isCloseTo(18.0, offset(0.0))
        assertThat(attempt.status).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(child.work.processCompletionTime).isCloseTo(20.0, offset(0.0))
        assertThat(child.work.isCompleted).isTrue()
        assertThat(child.work.isTerminated).isFalse()
        assertThat(attempt.timeoutEvent.cancel).isFalse()
        assertThat(rig.observations).containsExactly(
            Snapshot(14.5, 2, 1, 1, 1, 1, 1, 1),
            Snapshot(16.0, 2, 1, 1, 0, 1, 1, 1),
            Snapshot(18.5, 1, 0, 0, 0, 1, 1, 1),
            Snapshot(20.5, 0, 0, 0, 0, 1, 1, 1),
        )
        assertThat(rig.result().failedLatenciesMs).containsExactly(18.0)
        assertThat(
            rig
                .result()
                .services
                .getValue("entry")
                .timeouts,
        ).isEqualTo(1)
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
    }

    @Test
    fun `downstream process remains live after caller timeout during request network`() {
        val rig =
            simulate(
                scenario =
                    scenario(
                        entryProcessingMs = 0.0,
                        backendProcessingMs = 5.0,
                        network = fixed(20.0),
                        timeoutMs = 10.0,
                    ),
                requests = listOf(InvocationSpec()),
                observationTimesMs = listOf(10.5, 20.5, 30.5, 45.5),
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        val child = attempt!!.child
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(caller.work.processCompletionTime).isCloseTo(10.0, offset(0.0))
        assertThat(child.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(child.work.processCompletionTime).isCloseTo(45.0, offset(0.0))
        assertThat(child.work.isCompleted).isTrue()
        assertThat(child.work.isTerminated).isFalse()
        assertThat(rig.livenessObservations).containsExactly(
            LivenessSnapshot(10.5, 0, 0, 1),
            LivenessSnapshot(20.5, 1, 0, 1),
            LivenessSnapshot(30.5, 1, 0, 1),
            LivenessSnapshot(45.5, 0, 0, 0),
        )

        val result = rig.result()
        assertThat(result.failedLatenciesMs).containsExactly(10.0)
        assertThat(result.services.getValue("entry").timeouts).isEqualTo(1)
        assertThat(result.services.getValue("backend").offeredAttempts).isEqualTo(1)
        assertThat(result.services.getValue("backend").admittedAttempts).isEqualTo(1)
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
        assertThat(rig.reliabilityModel.activeDownstreamProcesses).isZero()
    }

    @Test
    fun `never admitted orphan remains live throughout its response network`() {
        val rig =
            simulate(
                scenario =
                    scenario(
                        entryProcessingMs = 0.0,
                        backendProcessingMs = 30.0,
                        network = fixed(20.0),
                        timeoutMs = 10.0,
                        backendQueueCapacity = 0,
                    ),
                requests =
                    listOf(
                        InvocationSpec(originalRequest = false, serviceId = "backend"),
                        InvocationSpec(),
                    ),
                observationTimesMs = listOf(10.5, 20.5, 30.5, 40.5),
            )

        val blocker = rig.invocations[0]
        val caller = rig.invocations[1]
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        val child = attempt!!.child
        assertThat(blocker.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(blocker.work.processCompletionTime).isCloseTo(30.0, offset(0.0))
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(caller.work.processCompletionTime).isCloseTo(10.0, offset(0.0))
        assertThat(child.outcome).isEqualTo(AttemptOutcome.QUEUE_REJECTED)
        assertThat(child.work.processCompletionTime).isCloseTo(40.0, offset(0.0))
        assertThat(child.work.isCompleted).isTrue()
        assertThat(child.work.isTerminated).isFalse()
        assertThat(rig.livenessObservations).containsExactly(
            LivenessSnapshot(10.5, 1, 0, 1),
            LivenessSnapshot(20.5, 1, 0, 1),
            LivenessSnapshot(30.5, 0, 0, 1),
            LivenessSnapshot(40.5, 0, 0, 0),
        )

        val result = rig.result()
        assertThat(result.failedLatenciesMs).containsExactly(10.0)
        assertThat(result.services.getValue("entry").timeouts).isEqualTo(1)
        assertThat(result.services.getValue("backend").offeredAttempts).isEqualTo(2)
        assertThat(result.services.getValue("backend").admittedAttempts).isEqualTo(1)
        assertThat(result.services.getValue("backend").queueRejections).isEqualTo(1)
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
        assertThat(rig.reliabilityModel.activeDownstreamProcesses).isZero()
        assertThat(rig.handlerBusy("entry")).isZero()
        assertThat(rig.handlerBusy("backend")).isZero()
    }

    @Test
    fun `replication termination during request network balances downstream liveness`() {
        val rig =
            simulate(
                scenario =
                    scenario(
                        entryProcessingMs = 0.0,
                        backendProcessingMs = 5.0,
                        network = fixed(20.0),
                        timeoutMs = 10.0,
                    ),
                requests = listOf(InvocationSpec()),
                replicationLengthMs = 15.0,
            )

        val caller = rig.invocations.single()
        val attempt = caller.callAttempt
        assertThat(attempt).isNotNull()
        val child = attempt!!.child
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(caller.work.processCompletionTime).isCloseTo(10.0, offset(0.0))
        assertThat(child.outcome).isEqualTo(AttemptOutcome.PENDING)
        assertThat(child.work.isTerminated).isTrue()
        assertThat(child.work.isCompleted).isFalse()
        assertThat(child.isProcessEnded).isTrue()
        assertThat(rig.reliabilityModel.activeDownstreamProcesses).isZero()
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()

        val result = rig.result()
        assertThat(result.arrivalTimesMs).containsExactly(0.0)
        assertThat(result.allLatenciesMs).containsExactly(10.0)
        assertThat(result.successfulLatenciesMs).isEmpty()
        assertThat(result.failedLatenciesMs).containsExactly(10.0)
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isZero()
        assertThat(result.failures).isEqualTo(1)
        assertThat(result.services.getValue("entry").offeredAttempts).isEqualTo(1)
        assertThat(result.services.getValue("entry").admittedAttempts).isEqualTo(1)
        assertThat(result.services.getValue("entry").timeouts).isEqualTo(1)
        assertThat(result.services.getValue("backend").offeredAttempts).isZero()
        assertThat(result.services.getValue("backend").admittedAttempts).isZero()
        assertThat(result.services.getValue("backend").queueRejections).isZero()
    }

    private fun networkSamples(meanMs: Double): Pair<Double, Double> {
        val provider =
            RNStreamProvider().apply {
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
            services =
                listOf(
                    base.services[0].copy(processing = fixed(entryProcessingMs)),
                    base.services[1].copy(
                        processing = fixed(backendProcessingMs),
                        queueCapacity = backendQueueCapacity ?: base.services[1].queueCapacity,
                    ),
                ),
            links =
                listOf(
                    base.links.single().copy(network = network, timeoutMs = timeoutMs, maxAttempts = 1),
                ),
        )
    }

    private fun fixed(durationMs: Double): DurationDistribution =
        DurationDistribution(
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

    private fun execution(): Execution =
        Execution(
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
        val livenessObservations = mutableListOf<LivenessSnapshot>()

        override fun initialize() {
            created.clear()
            observations.clear()
            livenessObservations.clear()
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
                process("observe-timeout-race") {
                    val result = reliabilityModel.metrics.replicationResult()
                    observations +=
                        Snapshot(
                            timeMs = time,
                            activeInvocations = reliabilityModel.activeInvocations,
                            activeOriginalRequests = reliabilityModel.activeOriginalRequests,
                            entryHandlerBusy = (model.getModelElement("entry") as ResourceWithQ).numBusy,
                            backendHandlerBusy = (model.getModelElement("backend") as ResourceWithQ).numBusy,
                            entryOffered = result.services.getValue("entry").offeredAttempts,
                            backendOffered = result.services.getValue("backend").offeredAttempts,
                            backendAdmitted = result.services.getValue("backend").admittedAttempts,
                        )
                    livenessObservations +=
                        LivenessSnapshot(
                            timeMs = time,
                            activeInvocations = reliabilityModel.activeInvocations,
                            activeOriginalRequests = reliabilityModel.activeOriginalRequests,
                            activeDownstreamProcesses = reliabilityModel.activeDownstreamProcesses,
                        )
                }
        }
    }
}
