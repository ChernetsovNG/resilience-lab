package io.github.chernetsovng.resiliencelab.core.simulation

import io.github.chernetsovng.resiliencelab.core.experiment.ReplicationResult
import io.github.chernetsovng.resiliencelab.core.experiment.ServiceMetrics
import io.github.chernetsovng.resiliencelab.core.scenario.Execution
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import io.github.chernetsovng.resiliencelab.core.scenario.TestData
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SingleServiceInvocationTest {
    @Test
    fun `fixed processing succeeds at 20 ms with offered and admitted counts`() {
        val rig = simulate(
            scenario = singleServiceScenario(),
            requests = listOf(InvocationSpec(arrivalTimeMs = 0.0)),
        )

        val invocation = rig.invocations.single()
        assertEquals(AttemptOutcome.SUCCEEDED, invocation.outcome)
        assertTrue(invocation.work.isCompleted)
        assertTrue(invocation.isProcessEnded)
        assertEquals(20.0, invocation.work.processCompletionTime, 0.0)

        val result = rig.result()
        assertEquals(listOf(0.0), result.arrivalTimesMs)
        assertEquals(listOf(20.0), result.allLatenciesMs)
        assertEquals(listOf(20.0), result.successfulLatenciesMs)
        assertEquals(emptyList(), result.failedLatenciesMs)
        assertEquals(1, result.originalArrivals)
        assertEquals(1, result.successes)
        assertEquals(0, result.failures)
        assertEquals(
            ServiceMetrics(
                offeredAttempts = 1,
                admittedAttempts = 1,
                timeouts = 0,
                retries = 0,
                failures = 0,
                queueRejections = 0,
                handlerUtilization = 0.0,
                meanQueueLength = 0.0,
                p95QueueLength = 0.0,
            ),
            result.services.getValue("entry"),
        )
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
    }

    @Test
    fun `local failure consumes processing and releases handler without downstream invocation`() {
        val base = TestData.simpleScenario()
        val scenario = base.copy(
            services = base.services.map { service ->
                if (service.id == "entry") service.copy(failureRate = 1.0) else service
            },
        )
        val rig = simulate(
            scenario = scenario,
            requests = listOf(
                InvocationSpec(arrivalTimeMs = 0.0, originalRequest = true),
                InvocationSpec(arrivalTimeMs = 21.0, originalRequest = false),
            ),
        )

        assertEquals(AttemptOutcome.LOCAL_FAILURE, rig.invocations[0].outcome)
        assertEquals(20.0, rig.invocations[0].work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.LOCAL_FAILURE, rig.invocations[1].outcome)
        assertEquals(41.0, rig.invocations[1].work.processCompletionTime, 0.0)

        val result = rig.result()
        assertEquals(listOf(0.0), result.arrivalTimesMs)
        assertEquals(listOf(20.0), result.allLatenciesMs)
        assertEquals(emptyList(), result.successfulLatenciesMs)
        assertEquals(listOf(20.0), result.failedLatenciesMs)
        assertEquals(1, result.originalArrivals)
        assertEquals(0, result.successes)
        assertEquals(1, result.failures)
        assertEquals(2, result.services.getValue("entry").offeredAttempts)
        assertEquals(2, result.services.getValue("entry").admittedAttempts)
        assertEquals(2, result.services.getValue("entry").failures)
        assertEquals(0, result.services.getValue("entry").queueRejections)
        assertEquals(0, result.services.getValue("backend").offeredAttempts)
        assertEquals(0, result.services.getValue("backend").admittedAttempts)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
    }

    @Test
    fun `zero capacity queue rejection counts offered but not admitted`() {
        val rig = simulate(
            scenario = singleServiceScenario(queueCapacity = 0),
            requests = listOf(
                InvocationSpec(arrivalTimeMs = 0.0, originalRequest = false),
                InvocationSpec(arrivalTimeMs = 1.0, originalRequest = true),
            ),
        )

        assertEquals(AttemptOutcome.SUCCEEDED, rig.invocations[0].outcome)
        assertEquals(20.0, rig.invocations[0].work.processCompletionTime, 0.0)
        assertEquals(AttemptOutcome.QUEUE_REJECTED, rig.invocations[1].outcome)
        assertEquals(1.0, rig.invocations[1].work.processCompletionTime, 0.0)

        val result = rig.result()
        assertEquals(listOf(1.0), result.arrivalTimesMs)
        assertEquals(listOf(0.0), result.allLatenciesMs)
        assertEquals(emptyList(), result.successfulLatenciesMs)
        assertEquals(listOf(0.0), result.failedLatenciesMs)
        assertEquals(1, result.originalArrivals)
        assertEquals(0, result.successes)
        assertEquals(1, result.failures)
        val service = result.services.getValue("entry")
        assertEquals(2, service.offeredAttempts)
        assertEquals(1, service.admittedAttempts)
        assertEquals(0, service.failures)
        assertEquals(1, service.queueRejections)
        assertEquals(0, rig.reliabilityModel.activeInvocations)
        assertEquals(0, rig.reliabilityModel.activeOriginalRequests)
    }

    @Test
    fun `active counters include accepted queued invocations and original requests until completion`() {
        val rig = simulate(
            scenario = singleServiceScenario(),
            requests = listOf(
                InvocationSpec(arrivalTimeMs = 0.0),
                InvocationSpec(arrivalTimeMs = 1.0),
            ),
            observationTimesMs = listOf(1.5, 20.5, 40.5),
        )

        assertEquals(
            listOf(
                ActiveCounts(1.5, 2, 2),
                ActiveCounts(20.5, 1, 1),
                ActiveCounts(40.5, 0, 0),
            ),
            rig.observations,
        )
        assertEquals(AttemptOutcome.SUCCEEDED, rig.invocations[0].outcome)
        assertEquals(AttemptOutcome.SUCCEEDED, rig.invocations[1].outcome)
        assertEquals(20.0, rig.invocations[0].work.processCompletionTime, 0.0)
        assertEquals(40.0, rig.invocations[1].work.processCompletionTime, 0.0)

        val result = rig.result()
        assertEquals(listOf(0.0, 1.0), result.arrivalTimesMs)
        assertEquals(listOf(20.0, 39.0), result.allLatenciesMs)
        assertEquals(listOf(20.0, 39.0), result.successfulLatenciesMs)
        assertEquals(2, result.originalArrivals)
        assertEquals(2, result.successes)
        assertEquals(0, result.failures)
        assertEquals(2, result.services.getValue("entry").offeredAttempts)
        assertEquals(2, result.services.getValue("entry").admittedAttempts)
    }

    @Test
    fun `replication result round trips through JSON`() {
        val rig = simulate(
            scenario = singleServiceScenario(),
            requests = listOf(InvocationSpec(arrivalTimeMs = 0.0)),
        )
        val result = rig.result()

        val encoded = Json.encodeToString(ReplicationResult.serializer(), result)
        val decoded = Json.decodeFromString(ReplicationResult.serializer(), encoded)

        assertEquals(result, decoded)
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
            services = listOf(
                base.services.first().copy(
                    queueCapacity = queueCapacity,
                    failureRate = failureRate,
                ),
            ),
            links = emptyList(),
        )
    }

    private fun execution(): Execution = Execution(
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
            val work = process("observe-active-counters") {
                observations += ActiveCounts(
                    timeMs = time,
                    invocations = reliabilityModel.activeInvocations,
                    originalRequests = reliabilityModel.activeOriginalRequests,
                )
            }
        }
    }
}
