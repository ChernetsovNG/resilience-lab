package resiliencelab.core.engine.ksl

import ksl.simulation.ModelElement
import ksl.utilities.random.rng.RNStreamIfc
import ksl.utilities.random.rvariable.KSLRandom
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.ir.ClientNode

/**
 * Generates the open, possibly non-homogeneous Poisson stream by thinning the maximum profile intensity.
 * Constant profiles retain the original exponential schedule and do not consume acceptance random numbers.
 * Warm-up requests affect system state but are outside the measured cohort; no arrivals are created at or after
 * the arrival boundary, leaving subsequent simulation time for completion and run-out.
 */
internal class ArrivalGenerator(
    private val reliabilityModel: ReliabilityModel,
    private val client: ClientNode,
    private val requestClass: String,
    private val warmupMs: Double,
    measurementMs: Double,
    private val stream: RNStreamIfc,
    private val acceptanceStream: RNStreamIfc?,
) : ModelElement(reliabilityModel, "workload:${client.path}:$requestClass:arrival-generator") {
    private val load = client.classes.getValue(requestClass)
    private val arrivalEndMs = warmupMs + measurementMs
    private val maximumRate = load.maximum(arrivalEndMs)
    private val meanInterArrivalMs = 1 / maximumRate
    private val arrivalAction =
        EventActionIfc<Nothing> {
            if (acceptanceStream == null || acceptanceStream.randU01() < load.rateAt(time) / maximumRate) {
                reliabilityModel.invoke(
                    serviceId = client.entry,
                    originalRequest = true,
                    measurementCohort = time >= warmupMs && time < arrivalEndMs,
                    client = client,
                    requestClass = requestClass,
                )
            }
            scheduleNext()
        }

    init {
        require(maximumRate >= 0.0 && maximumRate.isFinite()) { "Maximum load intensity must be finite and non-negative" }
    }

    override fun initialize() {
        scheduleNext()
    }

    private fun scheduleNext() {
        if (maximumRate == 0.0) return
        val delayMs = KSLRandom.rExponential(meanInterArrivalMs, stream)
        val nextArrivalMs = time + delayMs
        if (!nextArrivalMs.isFinite()) {
            throw ExperimentExecutionException(CoreMessage.EXECUTION_TIME_NEXT_ARRIVAL, "Next arrival time must be finite")
        }
        if (nextArrivalMs < arrivalEndMs) {
            schedule(arrivalAction, delayMs)
        }
    }
}
