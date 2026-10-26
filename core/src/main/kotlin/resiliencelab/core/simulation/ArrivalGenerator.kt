package resiliencelab.core.simulation

import ksl.simulation.ModelElement
import ksl.utilities.random.rvariable.ExponentialRV

/**
 * Generates the open Poisson stream of original requests through warm-up and the measurement interval.
 * Warm-up requests affect system state but are outside the measured cohort; no arrivals are created at or after
 * the arrival boundary, leaving subsequent simulation time for completion and run-out.
 */
internal class ArrivalGenerator(
    private val reliabilityModel: ReliabilityModel,
    private val entryServiceId: String,
    arrivalRate: Double,
    private val warmupMs: Double,
    measurementMs: Double,
    streamNum: Int,
) : ModelElement(reliabilityModel, "workload:arrival-generator") {
    private val interArrival =
        ExponentialRV(
            mean = 1 / arrivalRate,
            streamNum = streamNum,
            streamProvider = reliabilityModel.streamProvider,
        )
    private val arrivalEndMs = warmupMs + measurementMs
    private val arrivalAction =
        EventActionIfc<Nothing> {
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
