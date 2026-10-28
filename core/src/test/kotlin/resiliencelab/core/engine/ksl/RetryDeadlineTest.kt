package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.UniformRV
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.RetryKind
import resiliencelab.core.scenario.RetrySpec
import resiliencelab.core.scenario.Scenario
import resiliencelab.core.scenario.TestData
import kotlin.test.Test

class RetryDeadlineTest {
    @Test
    fun `none backoff is zero without sampling jitter`() {
        val retry = RetrySpec(RetryKind.NONE, 100.0, 7_000.0, base = 3.0)
        var jitterSampled = false

        val delayMs =
            RetryPolicyEvaluator.backoffMs(retry, failedAttemptNumber = 1) {
                jitterSampled = true
                0.999
            }

        assertThat(delayMs).isCloseTo(0.0, offset(0.0))
        assertThat(jitterSampled).isFalse()
    }

    @Test
    fun `fixed backoff is the minimum of base and cap`() {
        val belowCap = RetrySpec(RetryKind.FIXED, 100.0, 7_000.0, base = 3.0)
        val aboveCap = belowCap.copy(maxBackoffMs = 50.0)

        assertThat(RetryPolicyEvaluator.backoffMs(belowCap, 1) { 0.999 }).isCloseTo(100.0, offset(0.0))
        assertThat(RetryPolicyEvaluator.backoffMs(aboveCap, 4) { 0.999 }).isCloseTo(50.0, offset(0.0))
    }

    @Test
    fun `exponential backoff uses configurable base three and the cap`() {
        val retry = RetrySpec(RetryKind.EXPONENTIAL_FULL_JITTER, 100.0, 7_000.0, base = 3.0)

        val delaysMs =
            (1..6).map { failedAttempt ->
                RetryPolicyEvaluator.backoffMs(retry, failedAttempt) { 1.0 }
            }

        assertThat(delaysMs).containsExactly(100.0, 300.0, 900.0, 2700.0, 7000.0, 7000.0)
    }

    @Test
    fun `full jitter scales the capped exponential delay`() {
        val retry = RetrySpec(RetryKind.EXPONENTIAL_FULL_JITTER, 100.0, 7_000.0, base = 3.0)

        val zero = RetryPolicyEvaluator.backoffMs(retry, failedAttemptNumber = 5) { 0.0 }
        val almostCap = RetryPolicyEvaluator.backoffMs(retry, failedAttemptNumber = 5) { 0.999 }

        assertThat(zero).isCloseTo(0.0, offset(0.0))
        assertThat(almostCap).isCloseTo(6_993.0, offset(1e-9))
        assertThat(almostCap).isBetween(0.0, 7_000.0)
    }

    @Test
    fun `queue rejection is retried with a fresh child and then succeeds`() {
        val rig =
            simulate(
                scenario =
                    scenario(
                        backendProcessingMs = 10.0,
                        backendQueueCapacity = 0,
                        retry = fixedBackoff(20.0),
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
        assertThat(result.successfulLatenciesMs).containsExactly(30.0)
        assertThat(result.services.getValue("entry").retries).isEqualTo(1)
        assertThat(result.services.getValue("backend").offeredAttempts).isEqualTo(3)
        assertThat(result.services.getValue("backend").admittedAttempts).isEqualTo(2)
        assertThat(result.services.getValue("backend").queueRejections).isEqualTo(1)
        assertDrained(rig)
    }

    @Test
    fun `downstream local failure is retryable`() {
        val rig =
            simulate(
                scenario = scenario(backendFailureRate = 0.5),
                requests = listOf(InvocationSpec()),
                seed = failureThenSuccessSeed(),
            )

        val caller = rig.invocations.single()
        assertThat(caller.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(caller.work.processCompletionTime).isCloseTo(0.0, offset(0.0))
        val result = rig.result()
        assertThat(result.successfulLatenciesMs).containsExactly(0.0)
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
                scenario = scenario(backendFailureRate = 1.0, maxAttempts = 5),
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
        assertThat(result.failedLatenciesMs).containsExactly(0.0)
        assertDrained(rig)
    }

    @Test
    fun `caller handler stays allocated during backoff while a second request waits`() {
        val rig =
            simulate(
                scenario =
                    scenario(
                        backendProcessingMs = 10.0,
                        backendQueueCapacity = 0,
                        retry = fixedBackoff(20.0),
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
        assertThat(rig.result().successfulLatenciesMs).containsExactly(30.0, 35.0)
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
                scenario =
                    scenario(
                        backendProcessingMs = 100.0,
                        backendQueueCapacity = 0,
                        maxAttempts = 5,
                        retry = fixedBackoff(100.0),
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
                scenario =
                    scenario(
                        entryProcessingMs = 50.0,
                        requestDeadlineMs = 10.0,
                    ).copy(links = emptyList()),
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
                scenario =
                    scenario(
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
                scenario =
                    scenario(
                        backendProcessingMs = 40.0,
                        timeoutMs = 500.0,
                        maxAttempts = 1,
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
        assertThat(result.allLatenciesMs).containsExactly(40.0)
        assertThat(result.successfulLatenciesMs).containsExactly(40.0)
        assertThat(result.failedLatenciesMs).isEmpty()
        assertThat(result.services.getValue("entry").timeouts).isZero()
        assertDrained(rig)
    }

    @Test
    fun `capped timeout without response at deadline keeps deadline outcome`() {
        val rig =
            simulate(
                scenario =
                    scenario(
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
                scenario = threeServiceScenario(),
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
                scenario =
                    scenario(
                        backendProcessingMs = 5.0,
                        timeoutMs = 6.0,
                        retry = fixedBackoff(4.0),
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
        assertThat(rig.result().successfulLatenciesMs).containsExactly(15.0)
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
            services =
                listOf(
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
            links =
                listOf(
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
        val secondLink =
            base.links.single().copy(
                id = "backend-to-third",
                from = "backend",
                to = "third",
            )
        return base.copy(
            services = base.services + third,
            links = base.links + secondLink,
        )
    }

    private fun fixedBackoff(durationMs: Double): RetrySpec =
        RetrySpec(
            kind = RetryKind.FIXED,
            baseBackoffMs = durationMs,
            maxBackoffMs = durationMs,
        )

    private fun fixed(durationMs: Double): DurationDistribution =
        DurationDistribution(
            kind = DistributionKind.FIXED,
            meanMs = durationMs,
            stdDevMs = null,
        )

    private fun failureThenSuccessSeed(): Long {
        var candidate = 42L
        while (true) {
            val provider =
                RNStreamProvider().apply {
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

    private fun execution(seed: Long): Execution =
        Execution(
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
        assertThat(result.allLatenciesMs).containsExactly(latencyMs)
        assertThat(result.successfulLatenciesMs).isEmpty()
        assertThat(result.failedLatenciesMs).containsExactly(latencyMs)
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
                            originalCompletions = result.allLatenciesMs.size,
                        )
                    observedAttempts += created.lastOrNull()?.callAttempt
                }
        }
    }
}
