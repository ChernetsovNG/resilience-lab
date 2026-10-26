package resiliencelab.core.simulation

import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.scenario.DegradationSpec
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.Scenario
import resiliencelab.core.scenario.TestData
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.nanoseconds
import kotlin.time.Duration.Companion.seconds

class DegradationRunoutTest {
    @Test
    fun `degradation duration and failure are sampled once at actual local start`() {
        val base = TestData.simpleScenario()
        val scenario = base.copy(
            services = listOf(
                base.services.first().copy(
                    handlers = 4,
                    processing = fixed(5.0),
                    failureRate = 0.0,
                ),
            ),
            links = emptyList(),
            degradation = DegradationSpec(
                serviceId = "entry",
                startMs = 10.0,
                endMs = 20.0,
                processingMultiplier = 4.0,
                failureRate = 1.0,
            ),
        )
        val rig = simulateManual(
            scenario = scenario,
            requests = listOf(9.0, 10.0, 11.0, 20.0).map { InvocationSpec(it, measurementCohort = false) },
            execution = execution(warmupMs = 30.0, measurementMs = 100.0),
            replicationLengthMs = 40.0,
        )

        assertEquals(listOf(14.0, 30.0, 31.0, 25.0), rig.invocations.map { it.work.processCompletionTime })
        assertEquals(
            listOf(
                AttemptOutcome.SUCCEEDED,
                AttemptOutcome.LOCAL_FAILURE,
                AttemptOutcome.LOCAL_FAILURE,
                AttemptOutcome.SUCCEEDED,
            ),
            rig.invocations.map { it.outcome },
        )
        assertEquals(0, rig.result.originalArrivals)
        assertEquals(0, rig.result.services.getValue("entry").offeredAttempts)
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `Poisson arrivals stop strictly before measurement end`() {
        val scenario = singleServiceScenario(processingMs = 0.0, arrivalRate = 1.0)
        val execution = execution(warmupMs = 0.0, measurementMs = 25.0)
        val expected = expectedArrivals(
            seed = execution.seed,
            arrivalRate = scenario.workload.arrivalRate,
            streamNum = 3,
            endMs = 25.0,
        )
        assertTrue(expected.isNotEmpty())

        val rig = simulateOpen(scenario, execution)

        assertArrivalTimes(expected, rig.result.arrivalTimesMs)
        assertTrue(rig.result.arrivalTimesMs.all { it >= 0.0 && it < 25.0 })
        assertEquals(expected.size, rig.result.originalArrivals)
        assertEquals(expected.size, rig.result.successes)
        assertEquals(0, rig.result.failures)
        assertEquals(expected.size, rig.result.services.getValue("entry").offeredAttempts)
        assertEquals(25.0, rig.model.time, 1e-9)
        assertTrue(rig.model.lengthOfReplication.isInfinite())
        assertEquals(30.seconds, rig.model.maximumAllowedExecutionTimePerReplication)
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `warmup work occupies resources without entering original or nested attempt metrics`() {
        val base = TestData.simpleScenario()
        val scenario = base.copy(
            services = base.services.map {
                it.copy(handlers = 1, queueCapacity = 10_000, processing = fixed(20.0), failureRate = 0.0)
            },
            links = listOf(
                base.links.single().copy(
                    network = fixed(0.0),
                    timeoutMs = 100_000.0,
                    maxAttempts = 1,
                ),
            ),
            workload = base.workload.copy(arrivalRate = 10.0, requestDeadlineMs = 100_000.0),
        )
        val execution = execution(warmupMs = 10.0, measurementMs = 5.0)
        val allArrivals = expectedArrivals(
            seed = execution.seed,
            arrivalRate = scenario.workload.arrivalRate,
            streamNum = 7,
            endMs = 15.0,
        )
        val measurementArrivals = allArrivals.filter { it >= 10.0 }
        assertTrue(allArrivals.any { it < 5.0 })
        assertTrue(measurementArrivals.isNotEmpty())

        val rig = simulateOpen(scenario, execution, observationTimesMs = listOf(5.0))

        val warmup = rig.observations.single()
        assertEquals(1, warmup.entryHandlersBusy)
        assertTrue(warmup.activeOriginalRequests > 0)
        assertEquals(0, warmup.originalArrivals)
        assertEquals(mapOf("entry" to 0, "backend" to 0), warmup.offeredAttempts)
        assertArrivalTimes(measurementArrivals, rig.result.arrivalTimesMs)
        assertEquals(measurementArrivals.size, rig.result.originalArrivals)
        assertEquals(measurementArrivals.size, rig.result.successes)
        assertEquals(0, rig.result.failures)
        assertEquals(measurementArrivals.size, rig.result.allLatenciesMs.size)
        for (serviceId in listOf("entry", "backend")) {
            assertEquals(measurementArrivals.size, rig.result.services.getValue(serviceId).offeredAttempts)
            assertEquals(measurementArrivals.size, rig.result.services.getValue(serviceId).admittedAttempts)
            assertEquals(0, rig.result.services.getValue(serviceId).timeouts)
            assertEquals(0, rig.result.services.getValue(serviceId).failures)
        }
        assertTrue(rig.result.allLatenciesMs.all { it >= 40.0 })
        assertTrue(
            rig.result.arrivalTimesMs.zip(rig.result.allLatenciesMs).all { (arrival, latency) ->
                arrival + latency > 15.0
            },
        )
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `deadline failure after measurement end is recorded before accepted work drains`() {
        val window = findArrivalWindow(streamNum = 3) { it > 100.0 }
        val gapMs = window.secondMs - window.firstMs
        val scenario = singleServiceScenario(
            processingMs = gapMs,
            arrivalRate = 0.01,
            requestDeadlineMs = gapMs * 0.75,
        )
        val execution = execution(
            warmupMs = 0.0,
            measurementMs = window.firstMs + gapMs / 2.0,
            seed = window.seed,
        )

        val rig = simulateOpen(scenario, execution)

        assertArrivalTimes(listOf(window.firstMs), rig.result.arrivalTimesMs)
        assertEquals(1, rig.result.originalArrivals)
        assertEquals(0, rig.result.successes)
        assertEquals(1, rig.result.failures)
        assertEquals(listOf(gapMs * 0.75), rig.result.failedLatenciesMs)
        assertEquals(1, rig.result.services.getValue("entry").admittedAttempts)
        assertTrue(window.firstMs + gapMs * 0.75 > window.firstMs + gapMs / 2.0)
        assertTrue(rig.model.time >= window.firstMs + gapMs)
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `replication drains never admitted downstream work after every other counter is zero`() {
        val window = findArrivalWindow(streamNum = 7) { it in 60.0..70.0 }
        val gapMs = window.secondMs - window.firstMs
        val base = TestData.simpleScenario()
        val scenario = base.copy(
            services = listOf(
                base.services[0].copy(processing = fixed(0.0), failureRate = 0.0),
                base.services[1].copy(
                    processing = fixed(30.0),
                    failureRate = 0.0,
                    queueCapacity = 0,
                ),
            ),
            links = listOf(
                base.links.single().copy(
                    network = fixed(20.0),
                    timeoutMs = 10.0,
                    maxAttempts = 1,
                ),
            ),
            workload = base.workload.copy(arrivalRate = 0.01, requestDeadlineMs = 1_000.0),
        )
        val execution = execution(
            warmupMs = 0.0,
            measurementMs = window.firstMs + gapMs / 2.0,
            seed = window.seed,
        )
        val blocker = InvocationSpec(
            arrivalTimeMs = window.firstMs,
            originalRequest = false,
            serviceId = "backend",
            measurementCohort = false,
        )

        val rig = simulateOpen(scenario, execution, manualInvocations = listOf(blocker))

        assertArrivalTimes(listOf(window.firstMs), rig.result.arrivalTimesMs)
        assertEquals(listOf(10.0), rig.result.failedLatenciesMs)
        assertEquals(1, rig.result.services.getValue("entry").timeouts)
        assertEquals(1, rig.result.services.getValue("backend").offeredAttempts)
        assertEquals(0, rig.result.services.getValue("backend").admittedAttempts)
        assertEquals(1, rig.result.services.getValue("backend").queueRejections)
        assertTrue(window.firstMs + gapMs / 2.0 > window.firstMs + 30.0)
        assertTrue(rig.model.time >= window.firstMs + 40.0)
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `execution cap before drain surfaces ExperimentExecutionException`() {
        val scenario = singleServiceScenario(processingMs = 100.0, arrivalRate = 1_000.0)
        val execution = execution(warmupMs = 0.0, measurementMs = 1_000.0)
        val firstArrivalMs = expectedArrivals(
            seed = execution.seed,
            arrivalRate = scenario.workload.arrivalRate,
            streamNum = 3,
            endMs = 100.0,
        ).first()
        val model = Model("DegradationRunoutTest-cap", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, scenario, execution)
        model.maximumAllowedExecutionTimePerReplication = 1.nanoseconds

        assertFailsWith<ExperimentExecutionException> {
            reliabilityModel.runReplication()
        }

        assertTrue(model.time < firstArrivalMs + 100.0)
    }

    private fun singleServiceScenario(
        processingMs: Double,
        arrivalRate: Double,
        requestDeadlineMs: Double = 1_000.0,
    ): Scenario {
        val base = TestData.simpleScenario()
        return base.copy(
            services = listOf(
                base.services.first().copy(
                    handlers = 1,
                    queueCapacity = 10_000,
                    processing = fixed(processingMs),
                    failureRate = 0.0,
                ),
            ),
            links = emptyList(),
            workload = base.workload.copy(
                arrivalRate = arrivalRate,
                requestDeadlineMs = requestDeadlineMs,
            ),
            degradation = null,
        )
    }

    private fun simulateManual(
        scenario: Scenario,
        requests: List<InvocationSpec>,
        execution: Execution,
        replicationLengthMs: Double,
    ): SimulationRig {
        val model = Model("DegradationRunoutTest-manual", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, scenario, execution)
        val driver = InvocationDriver(model, reliabilityModel, requests, emptyList())
        model.numberOfReplications = 1
        model.lengthOfReplication = replicationLengthMs
        model.simulate()
        return SimulationRig(model, reliabilityModel, driver, reliabilityModel.metrics.replicationResult())
    }

    private fun simulateOpen(
        scenario: Scenario,
        execution: Execution,
        observationTimesMs: List<Double> = emptyList(),
        manualInvocations: List<InvocationSpec> = emptyList(),
    ): SimulationRig {
        val model = Model("DegradationRunoutTest-open", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, scenario, execution)
        val driver = InvocationDriver(model, reliabilityModel, manualInvocations, observationTimesMs)
        val result = reliabilityModel.runReplication()
        return SimulationRig(model, reliabilityModel, driver, result)
    }

    private fun execution(
        warmupMs: Double,
        measurementMs: Double,
        seed: Long = 42L,
    ): Execution = Execution(
        replications = 1,
        warmupMs = warmupMs,
        measurementMs = measurementMs,
        seed = seed,
        maxRealTimeSeconds = 30L,
    )

    private fun expectedArrivals(
        seed: Long,
        arrivalRate: Double,
        streamNum: Int,
        endMs: Double,
    ): List<Double> {
        val provider = RNStreamProvider().apply {
            initialSeed(SeedFactory.seedVector(seed))
        }
        val interArrival = ExponentialRV(mean = 1 / arrivalRate, streamNum = streamNum, streamProvider = provider)
        val arrivals = mutableListOf<Double>()
        var timeMs = 0.0
        while (true) {
            timeMs += interArrival.value
            if (timeMs >= endMs) break
            arrivals += timeMs
        }
        return arrivals
    }

    private fun findArrivalWindow(streamNum: Int, acceptGap: (Double) -> Boolean): ArrivalWindow {
        for (seed in 42L..10_000L) {
            val provider = RNStreamProvider().apply {
                initialSeed(SeedFactory.seedVector(seed))
            }
            val interArrival = ExponentialRV(mean = 100.0, streamNum = streamNum, streamProvider = provider)
            val firstMs = interArrival.value
            val secondMs = firstMs + interArrival.value
            if (acceptGap(secondMs - firstMs)) {
                return ArrivalWindow(seed, firstMs, secondMs)
            }
        }
        error("No deterministic arrival window found")
    }

    private fun assertArrivalTimes(expected: List<Double>, actual: List<Double>) {
        assertEquals(expected.size, actual.size)
        expected.zip(actual).forEach { (expectedTime, actualTime) ->
            assertEquals(expectedTime, actualTime, 1e-9)
        }
    }

    private fun assertDrained(model: ReliabilityModel) {
        assertEquals(0, model.activeOriginalRequests)
        assertEquals(0, model.activeInvocations)
        assertEquals(0, model.activeDownstreamProcesses)
    }

    private fun fixed(durationMs: Double): DurationDistribution = DurationDistribution(
        kind = DistributionKind.FIXED,
        meanMs = durationMs,
        stdDevMs = null,
    )

    private data class ArrivalWindow(val seed: Long, val firstMs: Double, val secondMs: Double)

    private data class InvocationSpec(
        val arrivalTimeMs: Double,
        val originalRequest: Boolean = true,
        val serviceId: String = "entry",
        val measurementCohort: Boolean = true,
    )

    private data class Observation(
        val timeMs: Double,
        val activeOriginalRequests: Int,
        val originalArrivals: Int,
        val entryHandlersBusy: Int,
        val offeredAttempts: Map<String, Int>,
    )

    private class SimulationRig(
        val model: Model,
        val reliabilityModel: ReliabilityModel,
        driver: InvocationDriver,
        val result: ReplicationResult,
    ) {
        val invocations: List<ReliabilityModel.ServiceInvocation> = driver.created
        val observations: List<Observation> = driver.observations
    }

    private class InvocationDriver(
        model: Model,
        private val reliabilityModel: ReliabilityModel,
        private val manualInvocations: List<InvocationSpec>,
        private val observationTimesMs: List<Double>,
    ) : ProcessModel(model) {
        val created = mutableListOf<ReliabilityModel.ServiceInvocation>()
        val observations = mutableListOf<Observation>()

        override fun initialize() {
            created.clear()
            observations.clear()
            manualInvocations.forEach { request ->
                created += reliabilityModel.invoke(
                    serviceId = request.serviceId,
                    timeUntilActivation = request.arrivalTimeMs,
                    originalRequest = request.originalRequest,
                    measurementCohort = request.measurementCohort,
                )
            }
            observationTimesMs.forEach { observationTime ->
                activate(ObservationProcess().work, observationTime)
            }
        }

        private inner class ObservationProcess : Entity() {
            val work = process("observe-degradation-runout") {
                val result = reliabilityModel.metrics.replicationResult()
                observations += Observation(
                    timeMs = time,
                    activeOriginalRequests = reliabilityModel.activeOriginalRequests,
                    originalArrivals = result.originalArrivals,
                    entryHandlersBusy = (model.getModelElement("entry") as ResourceWithQ).numBusy,
                    offeredAttempts = result.services.mapValues { (_, metrics) -> metrics.offeredAttempts },
                )
            }
        }
    }
}
