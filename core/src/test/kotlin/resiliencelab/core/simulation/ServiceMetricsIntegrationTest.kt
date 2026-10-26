package resiliencelab.core.simulation

import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.TestData
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import kotlin.test.Test

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

        assertThat(result.arrivalTimesMs).containsExactly(12.0)
        assertThat(result.allLatenciesMs).containsExactly(10.0)
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.successes).isEqualTo(1)
        assertThat(result.failures).isZero()
        assertThat(result.arrivalTimesMs[0] + result.allLatenciesMs[0]).isGreaterThan(15.0)
        val service = result.services.getValue("entry")
        assertThat(service.offeredAttempts).isEqualTo(1)
        assertThat(service.admittedAttempts).isEqualTo(1)
        assertThat(service.queueRejections).isZero()
        assertThat(service.handlerUtilization).isCloseTo(0.95, offset(1e-9))
        assertThat(service.meanQueueLength).isCloseTo(0.5, offset(1e-9))
        assertThat(service.p95QueueLength).isCloseTo(1.0, offset(1e-9))
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
