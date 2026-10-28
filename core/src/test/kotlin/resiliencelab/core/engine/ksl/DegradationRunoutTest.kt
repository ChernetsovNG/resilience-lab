package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.Model
import ksl.utilities.random.rvariable.KSLRandom
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.assertj.core.data.Offset.offset
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.RunSettings
import kotlin.test.Test
import kotlin.time.Duration.Companion.nanoseconds
import kotlin.time.Duration.Companion.seconds

class DegradationRunoutTest {
    @Test
    fun `degradation duration and failure are sampled once at actual local start`() {
        val base = TestChains.simple()
        val chain =
            base.copy(
                services =
                    listOf(
                        base.services.first().copy(
                            handlers = 4,
                            processing = fixed(5.0),
                            failureProbability = 0.0,
                        ),
                    ),
                calls = emptyList(),
                faults =
                    listOf(
                        FaultSpan(
                            target = "entry",
                            fromMs = 10.0,
                            toMs = 20.0,
                            processingMultiplier = 4.0,
                            failureProbability = 1.0,
                        ),
                    ),
            )
        val rig =
            simulateManual(
                chain = chain,
                requests = listOf(9.0, 10.0, 11.0, 20.0).map { InvocationSpec(it, measurementCohort = false) },
                execution = execution(warmupMs = 30.0, measurementMs = 100.0),
                replicationLengthMs = 40.0,
            )

        assertThat(rig.invocations.map { it.work.processCompletionTime }).containsExactly(14.0, 30.0, 31.0, 25.0)
        assertThat(rig.invocations.map { it.outcome }).containsExactly(
            AttemptOutcome.SUCCEEDED,
            AttemptOutcome.LOCAL_FAILURE,
            AttemptOutcome.LOCAL_FAILURE,
            AttemptOutcome.SUCCEEDED,
        )
        assertThat(rig.result.originalArrivals).isZero()
        assertThat(
            rig.result.services
                .getValue("entry")
                .offeredAttempts,
        ).isZero()
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `Poisson arrivals stop strictly before measurement end`() {
        val chain = singleServiceChain(processingMs = 0.0, arrivalRate = 1.0)
        val execution = execution(warmupMs = 0.0, measurementMs = 25.0)
        val expected =
            expectedArrivals(
                seed = execution.seed,
                arrivalRatePerMs = chain.client.arrivalRatePerMs,
                endMs = 25.0,
            )
        assertThat(expected).isNotEmpty()

        val rig = simulateOpen(chain, execution)

        assertArrivalTimes(expected, rig.result.arrivalTimesMs)
        assertThat(rig.result.arrivalTimesMs).allMatch { it >= 0.0 && it < 25.0 }
        assertThat(rig.result.originalArrivals).isEqualTo(expected.size)
        assertThat(rig.result.successes).isEqualTo(expected.size)
        assertThat(rig.result.failures).isZero()
        assertThat(
            rig.result.services
                .getValue("entry")
                .offeredAttempts,
        ).isEqualTo(expected.size)
        assertThat(rig.model.time).isCloseTo(25.0, offset(1e-9))
        assertThat(rig.model.lengthOfReplication.isInfinite()).isTrue()
        assertThat(rig.model.maximumAllowedExecutionTimePerReplication).isEqualTo(30.seconds)
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `warmup work occupies resources without entering original or nested attempt metrics`() {
        val base = TestChains.simple()
        val chain =
            base.copy(
                services =
                    base.services.map {
                        it.copy(handlers = 1, queueCapacity = 10_000, processing = fixed(20.0), failureProbability = 0.0)
                    },
                calls =
                    listOf(
                        base.calls.single().copy(
                            network = fixed(0.0),
                            timeoutMs = 100_000.0,
                            attempts = 1,
                        ),
                    ),
                client = base.client.copy(arrivalRatePerMs = 10.0, deadlineMs = 100_000.0),
            )
        val execution = execution(warmupMs = 10.0, measurementMs = 5.0)
        val allArrivals =
            expectedArrivals(
                seed = execution.seed,
                arrivalRatePerMs = chain.client.arrivalRatePerMs,
                endMs = 15.0,
            )
        val measurementArrivals = allArrivals.filter { it >= 10.0 }
        assertThat(allArrivals).anyMatch { it < 5.0 }
        assertThat(measurementArrivals).isNotEmpty()

        val rig = simulateOpen(chain, execution, observationTimesMs = listOf(5.0))

        val warmup = rig.observations.single()
        assertThat(warmup.entryHandlersBusy).isEqualTo(1)
        assertThat(warmup.activeOriginalRequests).isPositive()
        assertThat(warmup.originalArrivals).isZero()
        assertThat(warmup.offeredAttempts).containsExactlyEntriesOf(mapOf("entry" to 0, "backend" to 0))
        assertArrivalTimes(measurementArrivals, rig.result.arrivalTimesMs)
        assertThat(rig.result.originalArrivals).isEqualTo(measurementArrivals.size)
        assertThat(rig.result.successes).isEqualTo(measurementArrivals.size)
        assertThat(rig.result.failures).isZero()
        assertThat(rig.result.allLatenciesMs).hasSize(measurementArrivals.size)
        for (serviceId in listOf("entry", "backend")) {
            assertThat(
                rig.result.services
                    .getValue(serviceId)
                    .offeredAttempts,
            ).isEqualTo(measurementArrivals.size)
            assertThat(
                rig.result.services
                    .getValue(serviceId)
                    .admittedAttempts,
            ).isEqualTo(measurementArrivals.size)
            assertThat(
                rig.result.services
                    .getValue(serviceId)
                    .timeouts,
            ).isZero()
            assertThat(
                rig.result.services
                    .getValue(serviceId)
                    .failures,
            ).isZero()
        }
        assertThat(rig.result.allLatenciesMs).allMatch { it >= 40.0 }
        assertThat(rig.result.arrivalTimesMs.zip(rig.result.allLatenciesMs)).allMatch { (arrival, latency) ->
            arrival + latency > 15.0
        }
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `deadline failure after measurement end is recorded before accepted work drains`() {
        val window = findArrivalWindow { it > 100.0 }
        val gapMs = window.secondMs - window.firstMs
        val chain =
            singleServiceChain(
                processingMs = gapMs,
                arrivalRate = 0.01,
                requestDeadlineMs = gapMs * 0.75,
            )
        val execution =
            execution(
                warmupMs = 0.0,
                measurementMs = window.firstMs + gapMs / 2.0,
                seed = window.seed,
            )

        val rig = simulateOpen(chain, execution)

        assertArrivalTimes(listOf(window.firstMs), rig.result.arrivalTimesMs)
        assertThat(rig.result.originalArrivals).isEqualTo(1)
        assertThat(rig.result.successes).isZero()
        assertThat(rig.result.failures).isEqualTo(1)
        assertThat(rig.result.failedLatenciesMs).containsExactly(gapMs * 0.75)
        assertThat(
            rig.result.services
                .getValue("entry")
                .admittedAttempts,
        ).isEqualTo(1)
        assertThat(window.firstMs + gapMs * 0.75).isGreaterThan(window.firstMs + gapMs / 2.0)
        assertThat(rig.model.time).isGreaterThanOrEqualTo(window.firstMs + gapMs)
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `replication drains never admitted downstream work after every other counter is zero`() {
        val window = findArrivalWindow { it in 60.0..70.0 }
        val gapMs = window.secondMs - window.firstMs
        val base = TestChains.simple()
        val chain =
            base.copy(
                services =
                    listOf(
                        base.services[0].copy(processing = fixed(0.0), failureProbability = 0.0),
                        base.services[1].copy(
                            processing = fixed(30.0),
                            failureProbability = 0.0,
                            queueCapacity = 0,
                        ),
                    ),
                calls =
                    listOf(
                        base.calls.single().copy(
                            network = fixed(20.0),
                            timeoutMs = 10.0,
                            attempts = 1,
                        ),
                    ),
                client = base.client.copy(arrivalRatePerMs = 0.01, deadlineMs = 1_000.0),
            )
        val execution =
            execution(
                warmupMs = 0.0,
                measurementMs = window.firstMs + gapMs / 2.0,
                seed = window.seed,
            )
        val blocker =
            InvocationSpec(
                arrivalTimeMs = window.firstMs,
                originalRequest = false,
                serviceId = "backend",
                measurementCohort = false,
            )

        val rig = simulateOpen(chain, execution, manualInvocations = listOf(blocker))

        assertArrivalTimes(listOf(window.firstMs), rig.result.arrivalTimesMs)
        assertThat(rig.result.failedLatenciesMs).containsExactly(10.0)
        assertThat(
            rig.result.services
                .getValue("entry")
                .timeouts,
        ).isEqualTo(1)
        assertThat(
            rig.result.services
                .getValue("backend")
                .offeredAttempts,
        ).isEqualTo(1)
        assertThat(
            rig.result.services
                .getValue("backend")
                .admittedAttempts,
        ).isZero()
        assertThat(
            rig.result.services
                .getValue("backend")
                .queueRejections,
        ).isEqualTo(1)
        assertThat(window.firstMs + gapMs / 2.0).isGreaterThan(window.firstMs + 30.0)
        assertThat(rig.model.time).isGreaterThanOrEqualTo(window.firstMs + 40.0)
        assertDrained(rig.reliabilityModel)
    }

    @Test
    fun `execution cap before drain surfaces ExperimentExecutionException`() {
        val chain = singleServiceChain(processingMs = 100.0, arrivalRate = 1_000.0)
        val execution = execution(warmupMs = 0.0, measurementMs = 1_000.0)
        val firstArrivalMs =
            expectedArrivals(
                seed = execution.seed,
                arrivalRatePerMs = chain.client.arrivalRatePerMs,
                endMs = 100.0,
            ).first()
        val model = Model("DegradationRunoutTest-cap", autoCSVReports = false)
        val reliabilityModel = TestChains.reliabilityModel(model, chain.copy(run = execution))
        model.maximumAllowedExecutionTimePerReplication = 1.nanoseconds

        assertThatThrownBy { reliabilityModel.runReplication() }
            .isInstanceOf(ExperimentExecutionException::class.java)

        assertThat(model.time).isLessThan(firstArrivalMs + 100.0)
    }

    private fun singleServiceChain(
        processingMs: Double,
        arrivalRate: Double,
        requestDeadlineMs: Double = 1_000.0,
    ): ChainIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                listOf(
                    base.services.first().copy(
                        handlers = 1,
                        queueCapacity = 10_000,
                        processing = fixed(processingMs),
                        failureProbability = 0.0,
                    ),
                ),
            calls = emptyList(),
            client =
                base.client.copy(
                    arrivalRatePerMs = arrivalRate,
                    deadlineMs = requestDeadlineMs,
                ),
            faults = emptyList(),
        )
    }

    private fun simulateManual(
        chain: ChainIr,
        requests: List<InvocationSpec>,
        execution: RunSettings,
        replicationLengthMs: Double,
    ): SimulationRig {
        val model = Model("DegradationRunoutTest-manual", autoCSVReports = false)
        val reliabilityModel = TestChains.reliabilityModel(model, chain.copy(run = execution))
        val driver = InvocationDriver(model, reliabilityModel, requests, emptyList())
        model.numberOfReplications = 1
        model.lengthOfReplication = replicationLengthMs
        model.simulate()
        return SimulationRig(model, reliabilityModel, driver, reliabilityModel.metrics.replicationResult())
    }

    private fun simulateOpen(
        chain: ChainIr,
        execution: RunSettings,
        observationTimesMs: List<Double> = emptyList(),
        manualInvocations: List<InvocationSpec> = emptyList(),
    ): SimulationRig {
        val model = Model("DegradationRunoutTest-open", autoCSVReports = false)
        val reliabilityModel = TestChains.reliabilityModel(model, chain.copy(run = execution))
        val driver = InvocationDriver(model, reliabilityModel, manualInvocations, observationTimesMs)
        val result = reliabilityModel.runReplication()
        return SimulationRig(model, reliabilityModel, driver, result)
    }

    private fun execution(
        warmupMs: Double,
        measurementMs: Double,
        seed: Long = 42L,
    ): RunSettings =
        RunSettings(
            replications = 1,
            warmupMs = warmupMs,
            measurementMs = measurementMs,
            seed = seed,
            maxRealTimeSeconds = 30L,
        )

    private fun expectedArrivals(
        seed: Long,
        arrivalRatePerMs: Double,
        endMs: Double,
    ): List<Double> = TestChains.expectedArrivals(seed, arrivalRatePerMs, endMs)

    /** First seed from 42 whose first two arrivals at 0.01 requests/ms are [acceptGap] apart. */
    private fun findArrivalWindow(acceptGap: (Double) -> Boolean): ArrivalWindow {
        for (seed in 42L..10_000L) {
            val arrivals = TestChains.stream(seed, TestChains.CLIENT, StreamRole.ARRIVALS)
            val firstMs = KSLRandom.rExponential(100.0, arrivals)
            val secondMs = firstMs + KSLRandom.rExponential(100.0, arrivals)
            if (acceptGap(secondMs - firstMs)) {
                return ArrivalWindow(seed, firstMs, secondMs)
            }
        }
        error("No deterministic arrival window found")
    }

    private fun assertArrivalTimes(
        expected: List<Double>,
        actual: List<Double>,
    ) {
        assertThat(actual).hasSize(expected.size)
        expected.zip(actual).forEach { (expectedTime, actualTime) ->
            assertThat(actualTime).isCloseTo(expectedTime, offset(1e-9))
        }
    }

    private fun assertDrained(model: ReliabilityModel) {
        assertThat(model.activeOriginalRequests).isZero()
        assertThat(model.activeInvocations).isZero()
        assertThat(model.activeDownstreamProcesses).isZero()
    }

    private fun fixed(durationMs: Double): Distribution = TestChains.fixed(durationMs)

    private data class ArrivalWindow(
        val seed: Long,
        val firstMs: Double,
        val secondMs: Double,
    )

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
                created +=
                    reliabilityModel.invoke(
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
            val work =
                process("observe-degradation-runout") {
                    val result = reliabilityModel.metrics.replicationResult()
                    observations +=
                        Observation(
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
