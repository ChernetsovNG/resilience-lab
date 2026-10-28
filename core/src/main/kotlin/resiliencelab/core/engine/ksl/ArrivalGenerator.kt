package resiliencelab.core.engine.ksl

import ksl.simulation.ModelElement
import ksl.utilities.random.rng.RNStreamIfc
import ksl.utilities.random.rvariable.KSLRandom

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
    private val stream: RNStreamIfc,
) : ModelElement(reliabilityModel, "workload:arrival-generator") {
    /** MVP overload; removed with the `scenario` package. */
    constructor(
        reliabilityModel: ReliabilityModel,
        entryServiceId: String,
        arrivalRate: Double,
        warmupMs: Double,
        measurementMs: Double,
        streamNum: Int,
    ) : this(
        reliabilityModel,
        entryServiceId,
        arrivalRate,
        warmupMs,
        measurementMs,
        reliabilityModel.streamProvider.rnStream(streamNum),
    )

    private val meanInterArrivalMs = 1 / arrivalRate
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

    init {
        require(meanInterArrivalMs > 0.0) { "Exponential mean must be > 0.0" }
    }

    override fun initialize() {
        scheduleNext()
    }

    private fun scheduleNext() {
        val delayMs = KSLRandom.rExponential(meanInterArrivalMs, stream)
        val nextArrivalMs = time + delayMs
        if (!nextArrivalMs.isFinite()) {
            throw ExperimentExecutionException("Next arrival time must be finite")
        }
        if (nextArrivalMs < arrivalEndMs) {
            schedule(arrivalAction, delayMs)
        }
    }
}
