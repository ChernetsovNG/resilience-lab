package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import ksl.simulation.ModelElement
import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatExceptionOfType
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.RunSettings
import kotlin.test.Test

class TimingArithmeticTest {
    @Test
    fun `original request deadline overflow is rejected before scheduling`() {
        val model = Model("OriginalDeadlineOverflow", autoCSVReports = false)
        val reliabilityModel = reliabilityModel(model, requestDeadlineMs = Double.MAX_VALUE)

        assertThatExceptionOfType(ExperimentExecutionException::class.java)
            .isThrownBy {
                reliabilityModel.invoke(
                    serviceId = "entry",
                    timeUntilActivation = Double.MAX_VALUE,
                    originalRequest = true,
                )
            }.withMessageContaining("deadline")
    }

    @Test
    fun `original request arrival overflow is rejected before activation`() {
        val model = Model("OriginalArrivalOverflow", autoCSVReports = false)
        val reliabilityModel = reliabilityModel(model)
        InvocationAtLateTime(model) {
            reliabilityModel.invoke(
                serviceId = "entry",
                timeUntilActivation = Double.MAX_VALUE,
                originalRequest = true,
            )
        }

        assertThatExceptionOfType(ExperimentExecutionException::class.java)
            .isThrownBy { model.simulate() }
            .withMessageContaining("arrival")
    }

    @Test
    fun `nonfinite next arrival candidate is rejected`() {
        val model = Model("NextArrivalOverflow", autoCSVReports = false)
        val reliabilityModel = reliabilityModel(model)
        ArrivalGenerator(
            reliabilityModel = reliabilityModel,
            entryServiceId = "entry",
            load = LoadProfile.constant(1.0 / Double.MAX_VALUE),
            warmupMs = Double.MAX_VALUE,
            measurementMs = Double.MAX_VALUE,
            stream = TestChains.stream(42L, TestChains.CLIENT, StreamRole.ARRIVALS),
            acceptanceStream = null,
        )

        assertThatExceptionOfType(ExperimentExecutionException::class.java)
            .isThrownBy { model.simulate() }
            .withMessageContaining("Next arrival")
    }

    @Test
    fun `direct nonoriginal invocation retains its infinite deadline`() {
        val model = Model("DirectNonOriginalInvocation", autoCSVReports = false)
        val reliabilityModel = reliabilityModel(model, requestDeadlineMs = Double.MAX_VALUE)

        assertThatCode {
            reliabilityModel.invoke(
                serviceId = "entry",
                timeUntilActivation = Double.MAX_VALUE,
                originalRequest = false,
            )
        }.doesNotThrowAnyException()
    }

    private fun reliabilityModel(
        model: Model,
        requestDeadlineMs: Double = 500.0,
    ): ReliabilityModel {
        val base = TestChains.simple()
        val chain =
            base.copy(
                services = listOf(base.services.first()),
                calls = emptyList(),
                client = base.client.copy(deadlineMs = requestDeadlineMs),
            )
        return TestChains.reliabilityModel(model, chain.copy(run = execution()))
    }

    private fun execution(): RunSettings =
        RunSettings(
            replications = 1,
            warmupMs = 0.0,
            measurementMs = 100.0,
            seed = 42L,
            maxRealTimeSeconds = 30L,
        )

    private class InvocationAtLateTime(
        model: Model,
        private val action: () -> Unit,
    ) : ProcessModel(model) {
        override fun initialize() {
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { action() },
                timeToEvent = Double.MAX_VALUE,
            )
        }
    }
}
