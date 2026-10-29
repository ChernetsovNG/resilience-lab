package resiliencelab.core.engine.ksl

import ksl.simulation.KSLEvent

/**
 * Coordinates one caller's wait for a downstream invocation.
 * A timeout resumes only the caller and never cancels the child; the first terminal signal wins, so a late child
 * completion cannot change a timed-out attempt.
 */
internal class CallAttempt(
    val child: ReliabilityModel.ServiceInvocation,
    val timeoutEvent: KSLEvent<*>,
    private val caller: ReliabilityModel.ServiceInvocation,
    private val recordTimeout: (Boolean) -> Unit,
    private val recordResponse: (Boolean) -> Unit,
    private val recordOrphanCompleted: () -> Unit,
) {
    var status: AttemptOutcome = AttemptOutcome.PENDING
        private set
    private var childEnded = false
    private var orphaned = false

    fun onChildCompleted() {
        if (status != AttemptOutcome.PENDING) return
        status =
            if (child.outcome == AttemptOutcome.SUCCEEDED) {
                AttemptOutcome.SUCCEEDED
            } else {
                AttemptOutcome.DOWNSTREAM_FAILURE
            }
        recordResponse(status == AttemptOutcome.SUCCEEDED)
        if (timeoutEvent.isScheduled) {
            timeoutEvent.cancel = true
        }
    }

    fun onTimeout() {
        if (status != AttemptOutcome.PENDING) return
        status = AttemptOutcome.TIMED_OUT
        orphaned = !childEnded
        recordTimeout(orphaned)
        caller.resumeProcess()
    }

    fun onChildProcessEnded() {
        childEnded = true
        if (orphaned) {
            orphaned = false
            recordOrphanCompleted()
        }
    }
}
