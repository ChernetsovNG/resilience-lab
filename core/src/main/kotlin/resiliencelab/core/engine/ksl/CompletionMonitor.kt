package resiliencelab.core.engine.ksl

import ksl.simulation.ModelElement

/**
 * Ends a replication only after arrivals have stopped, all original client outcomes are known, and all accepted
 * invocation and downstream process work has drained, including work orphaned by timeouts or deadlines.
 */
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
