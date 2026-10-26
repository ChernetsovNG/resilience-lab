package resiliencelab.core.simulation

import ksl.simulation.KSLEvent

internal class CallAttempt(
    val child: ReliabilityModel.ServiceInvocation,
    val timeoutEvent: KSLEvent<*>,
    private val caller: ReliabilityModel.ServiceInvocation,
    private val recordTimeout: () -> Unit,
) {
    var status: AttemptOutcome = AttemptOutcome.PENDING
        private set

    fun onChildCompleted() {
        if (status != AttemptOutcome.PENDING) return
        status = if (child.outcome == AttemptOutcome.SUCCEEDED) {
            AttemptOutcome.SUCCEEDED
        } else {
            AttemptOutcome.DOWNSTREAM_FAILURE
        }
        if (timeoutEvent.isScheduled) {
            timeoutEvent.cancel = true
        }
    }

    fun onTimeout() {
        if (status != AttemptOutcome.PENDING) return
        status = AttemptOutcome.TIMED_OUT
        recordTimeout()
        caller.resumeProcess()
    }
}
