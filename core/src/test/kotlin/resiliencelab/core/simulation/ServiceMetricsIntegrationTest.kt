package resiliencelab.core.simulation

import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.TestData
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ServiceMetricsIntegrationTest {
    @Test
    fun `service measurements include initial warmup work and stop at measurement end`() {
        val base = TestData.simpleScenario()
        val scenario = base.copy(
            services = listOf(
                base.services.first().copy(
                    handlers = 2,
                    queueCapacity = 2,
                    processing = DurationDistribution(
                        kind = DistributionKind.FIXED,
                        meanMs = 10.0,
                        stdDevMs = null,
                    ),
                    failureRate = 0.0,
                ),
            ),
            links = emptyList(),
            degradation = null,
        )
        val execution = Execution(
            replications = 1,
            warmupMs = 5.0,
            measurementMs = 10.0,
            seed = 42L,
            maxRealTimeSeconds = 30L,
        )
        val model = Model("ServiceMetricsIntegrationTest", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, scenario, execution)
        InvocationDriver(
            model = model,
            reliabilityModel = reliabilityModel,
            requests = listOf(
                Request(atMs = 0.0, original = false, measurementCohort = false),
                Request(atMs = 1.0, original = false, measurementCohort = false),
                Request(atMs = 2.0, original = false, measurementCohort = false),
                Request(atMs = 12.0, original = true, measurementCohort = true),
            ),
        )
        model.numberOfReplications = 1
        model.lengthOfReplication = 30.0

        model.simulate()
        val result = reliabilityModel.metrics.replicationResult()

        assertEquals(listOf(12.0), result.arrivalTimesMs)
        assertEquals(listOf(10.0), result.allLatenciesMs)
        assertEquals(1, result.originalArrivals)
        assertEquals(1, result.successes)
        assertEquals(0, result.failures)
        assertTrue(result.arrivalTimesMs[0] + result.allLatenciesMs[0] > 15.0)
        val service = result.services.getValue("entry")
        assertEquals(1, service.offeredAttempts)
        assertEquals(1, service.admittedAttempts)
        assertEquals(0, service.queueRejections)
        assertEquals(0.95, service.handlerUtilization, 1e-9)
        assertEquals(0.5, service.meanQueueLength, 1e-9)
        assertEquals(1.0, service.p95QueueLength, 1e-9)
    }

    private data class Request(
        val atMs: Double,
        val original: Boolean,
        val measurementCohort: Boolean,
    )

    private class InvocationDriver(
        model: Model,
        private val reliabilityModel: ReliabilityModel,
        private val requests: List<Request>,
    ) : ProcessModel(model) {
        override fun initialize() {
            requests.forEach { request ->
                reliabilityModel.invoke(
                    serviceId = "entry",
                    timeUntilActivation = request.atMs,
                    originalRequest = request.original,
                    measurementCohort = request.measurementCohort,
                )
            }
        }
    }
}
