package resiliencelab.core.simulation

import ksl.simulation.ModelElement

internal class CompletionMonitor(
    private val reliabilityModel: ReliabilityModel,
    private val arrivalEndMs: Double,
) : ModelElement(reliabilityModel, "workload:completion-monitor") {
    private val monitorAction = EventActionIfc<Nothing> { checkCompletion() }

    override fun initialize() {
        schedule(monitorAction, arrivalEndMs)
    }

    private fun checkCompletion() {
        if (
            time >= arrivalEndMs &&
            reliabilityModel.activeOriginalRequests == 0 &&
            reliabilityModel.activeInvocations == 0 &&
            reliabilityModel.activeDownstreamProcesses == 0
        ) {
            stopReplication("Workload arrivals ended and all work drained")
        } else {
            schedule(monitorAction, 1.0)
        }
    }
}
