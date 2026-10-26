package resiliencelab.core.simulation

import ksl.simulation.ModelElement
import ksl.utilities.random.rvariable.ExponentialRV

internal class ArrivalGenerator(
    private val reliabilityModel: ReliabilityModel,
    private val entryServiceId: String,
    arrivalRate: Double,
    private val warmupMs: Double,
    measurementMs: Double,
    streamNum: Int,
) : ModelElement(reliabilityModel, "workload:arrival-generator") {
    private val interArrival = ExponentialRV(
        mean = 1 / arrivalRate,
        streamNum = streamNum,
        streamProvider = reliabilityModel.streamProvider,
    )
    private val arrivalEndMs = warmupMs + measurementMs
    private val arrivalAction = EventActionIfc<Nothing> {
        reliabilityModel.invoke(
            serviceId = entryServiceId,
            originalRequest = true,
            measurementCohort = time >= warmupMs && time < arrivalEndMs,
        )
        scheduleNext()
    }

    override fun initialize() {
        scheduleNext()
    }

    private fun scheduleNext() {
        val delayMs = interArrival.value
        if (time + delayMs < arrivalEndMs) {
            schedule(arrivalAction, delayMs)
        }
    }
}
