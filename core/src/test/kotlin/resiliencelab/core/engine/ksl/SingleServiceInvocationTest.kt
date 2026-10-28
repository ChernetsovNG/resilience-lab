package resiliencelab.core.engine.ksl

import kotlinx.serialization.json.Json
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.experiment.ServiceMetrics
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.Scenario
import resiliencelab.core.scenario.TestData
import kotlin.test.Test

class SingleServiceInvocationTest {
    @Test
    fun `fixed processing succeeds at 20 ms with offered and admitted counts`() {
        val rig =
            simulate(
                scenario = singleServiceScenario(),
                requests = listOf(InvocationSpec(arrivalTimeMs = 0.0)),
            )

        val invocation = rig.invocations.single()
        assertThat(invocation.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(invocation.work.isCompleted).isTrue()
        assertThat(invocation.isProcessEnded).isTrue()
        assertThat(invocation.work.processCompletionTime).isCloseTo(20.0, offset(0.0))

        val result = rig.result()
        assertThat(result.arrivalTimesMs).containsExactly(0.0)
        assertThat(result.allLatenciesMs).containsExactly(20.0)
        assertThat(result.successfulLatenciesMs).containsExactly(20.0)
        assertThat(result.failedLatenciesMs).isEmpty()
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isEqualTo(1)
        assertThat(result.failures).isZero()
        assertThat(result.services.getValue("entry")).isEqualTo(
            ServiceMetrics(
                offeredAttempts = 1,
                admittedAttempts = 1,
                timeouts = 0,
                retries = 0,
                failures = 0,
                queueRejections = 0,
                handlerUtilization = 0.2,
                meanQueueLength = 0.0,
                p95QueueLength = 0.0,
            ),
        )
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
    }

    @Test
    fun `local failure consumes processing and releases handler without downstream invocation`() {
        val base = TestData.simpleScenario()
        val scenario =
            base.copy(
                services =
                    base.services.map { service ->
                        if (service.id == "entry") service.copy(failureRate = 1.0) else service
                    },
            )
        val rig =
            simulate(
                scenario = scenario,
                requests =
                    listOf(
                        InvocationSpec(arrivalTimeMs = 0.0, originalRequest = true),
                        InvocationSpec(arrivalTimeMs = 21.0, originalRequest = false),
                    ),
            )

        assertThat(rig.invocations[0].outcome).isEqualTo(AttemptOutcome.LOCAL_FAILURE)
        assertThat(rig.invocations[0].work.processCompletionTime).isCloseTo(20.0, offset(0.0))
        assertThat(rig.invocations[1].outcome).isEqualTo(AttemptOutcome.LOCAL_FAILURE)
        assertThat(rig.invocations[1].work.processCompletionTime).isCloseTo(41.0, offset(0.0))

        val result = rig.result()
        assertThat(result.arrivalTimesMs).containsExactly(0.0)
        assertThat(result.allLatenciesMs).containsExactly(20.0)
        assertThat(result.successfulLatenciesMs).isEmpty()
        assertThat(result.failedLatenciesMs).containsExactly(20.0)
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isZero()
        assertThat(result.failures).isEqualTo(1)
        assertThat(result.services.getValue("entry").offeredAttempts).isEqualTo(2)
        assertThat(result.services.getValue("entry").admittedAttempts).isEqualTo(2)
        assertThat(result.services.getValue("entry").failures).isEqualTo(2)
        assertThat(result.services.getValue("entry").queueRejections).isZero()
        assertThat(result.services.getValue("backend").offeredAttempts).isZero()
        assertThat(result.services.getValue("backend").admittedAttempts).isZero()
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
    }

    @Test
    fun `zero capacity queue rejection counts offered but not admitted`() {
        val rig =
            simulate(
                scenario = singleServiceScenario(queueCapacity = 0),
                requests =
                    listOf(
                        InvocationSpec(arrivalTimeMs = 0.0, originalRequest = false),
                        InvocationSpec(arrivalTimeMs = 1.0, originalRequest = true),
                    ),
            )

        assertThat(rig.invocations[0].outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(rig.invocations[0].work.processCompletionTime).isCloseTo(20.0, offset(0.0))
        assertThat(rig.invocations[1].outcome).isEqualTo(AttemptOutcome.QUEUE_REJECTED)
        assertThat(rig.invocations[1].work.processCompletionTime).isCloseTo(1.0, offset(0.0))

        val result = rig.result()
        assertThat(result.arrivalTimesMs).containsExactly(1.0)
        assertThat(result.allLatenciesMs).containsExactly(0.0)
        assertThat(result.successfulLatenciesMs).isEmpty()
        assertThat(result.failedLatenciesMs).containsExactly(0.0)
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isZero()
        assertThat(result.failures).isEqualTo(1)
        val service = result.services.getValue("entry")
        assertThat(service.offeredAttempts).isEqualTo(2)
        assertThat(service.admittedAttempts).isEqualTo(1)
        assertThat(service.failures).isZero()
        assertThat(service.queueRejections).isEqualTo(1)
        assertThat(rig.reliabilityModel.activeInvocations).isZero()
        assertThat(rig.reliabilityModel.activeOriginalRequests).isZero()
    }

    @Test
    fun `active counters include accepted queued invocations and original requests until completion`() {
        val rig =
            simulate(
                scenario = singleServiceScenario(),
                requests =
                    listOf(
                        InvocationSpec(arrivalTimeMs = 0.0),
                        InvocationSpec(arrivalTimeMs = 1.0),
                    ),
                observationTimesMs = listOf(1.5, 20.5, 40.5),
            )

        assertThat(rig.observations).containsExactly(
            ActiveCounts(1.5, 2, 2),
            ActiveCounts(20.5, 1, 1),
            ActiveCounts(40.5, 0, 0),
        )
        assertThat(rig.invocations[0].outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(rig.invocations[1].outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(rig.invocations[0].work.processCompletionTime).isCloseTo(20.0, offset(0.0))
        assertThat(rig.invocations[1].work.processCompletionTime).isCloseTo(40.0, offset(0.0))

        val result = rig.result()
        assertThat(result.arrivalTimesMs).containsExactly(0.0, 1.0)
        assertThat(result.allLatenciesMs).containsExactly(20.0, 39.0)
        assertThat(result.successfulLatenciesMs).containsExactly(20.0, 39.0)
        assertThat(result.originalArrivals).isEqualTo(2)
        assertThat(result.successes).isEqualTo(2)
        assertThat(result.failures).isZero()
        assertThat(result.services.getValue("entry").offeredAttempts).isEqualTo(2)
        assertThat(result.services.getValue("entry").admittedAttempts).isEqualTo(2)
    }

    @Test
    fun `replication result round trips through JSON`() {
        val rig =
            simulate(
                scenario = singleServiceScenario(),
                requests = listOf(InvocationSpec(arrivalTimeMs = 0.0)),
            )
        val result = rig.result()

        val encoded = Json.encodeToString(ReplicationResult.serializer(), result)
        val decoded = Json.decodeFromString(ReplicationResult.serializer(), encoded)

        assertThat(decoded).isEqualTo(result)
    }

    private fun simulate(
        scenario: Scenario,
        requests: List<InvocationSpec>,
        observationTimesMs: List<Double> = emptyList(),
    ): SimulationRig {
        val model = Model("SingleServiceInvocationTest", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, scenario, execution())
        val driver = InvocationDriver(model, reliabilityModel, requests, observationTimesMs)
        model.numberOfReplications = 1
        model.lengthOfReplication = 100.0
        model.simulate()
        return SimulationRig(reliabilityModel, driver)
    }

    private fun singleServiceScenario(
        queueCapacity: Int = 2,
        failureRate: Double = 0.0,
    ): Scenario {
        val base = TestData.simpleScenario()
        return base.copy(
            services =
                listOf(
                    base.services.first().copy(
                        queueCapacity = queueCapacity,
                        failureRate = failureRate,
                    ),
                ),
            links = emptyList(),
        )
    }

    private fun execution(): Execution =
        Execution(
            replications = 1,
            warmupMs = 0.0,
            measurementMs = 100.0,
            seed = 42L,
            maxRealTimeSeconds = 30L,
        )

    private data class InvocationSpec(
        val arrivalTimeMs: Double,
        val originalRequest: Boolean = true,
        val serviceId: String = "entry",
    )

    private data class ActiveCounts(
        val timeMs: Double,
        val invocations: Int,
        val originalRequests: Int,
    )

    private class SimulationRig(
        val reliabilityModel: ReliabilityModel,
        private val driver: InvocationDriver,
    ) {
        val invocations: List<ReliabilityModel.ServiceInvocation>
            get() = driver.created
        val observations: List<ActiveCounts>
            get() = driver.observations

        fun result(): ReplicationResult = reliabilityModel.metrics.replicationResult()
    }

    private class InvocationDriver(
        model: Model,
        private val reliabilityModel: ReliabilityModel,
        private val requests: List<InvocationSpec>,
        private val observationTimesMs: List<Double>,
    ) : ProcessModel(model) {
        val created = mutableListOf<ReliabilityModel.ServiceInvocation>()
        val observations = mutableListOf<ActiveCounts>()

        override fun initialize() {
            created.clear()
            observations.clear()
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
                process("observe-active-counters") {
                    observations +=
                        ActiveCounts(
                            timeMs = time,
                            invocations = reliabilityModel.activeInvocations,
                            originalRequests = reliabilityModel.activeOriginalRequests,
                        )
                }
        }
    }
}
