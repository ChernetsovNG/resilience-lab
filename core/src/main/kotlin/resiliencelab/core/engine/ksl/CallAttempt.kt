package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.KSLEvent

/**
 * Coordinates one caller's wait for a downstream invocation.
 * A timeout resumes only the caller and never cancels the child; the first terminal signal wins, so a late child
 * completion cannot change a timed-out attempt.
 */
internal class CallAttempt(
    val child: ReliabilityModel.ServiceInvocation,
    val timeoutEvent: KSLEvent<*>,
    private val caller: ProcessModel.Entity,
    private val recordTimeout: (Boolean) -> Unit,
    private val recordResponse: (AttemptOutcome) -> Unit,
    private val recordOrphanCompleted: () -> Unit,
) {
    var status: AttemptOutcome = AttemptOutcome.PENDING
        private set
    private var childEnded = false
    private var orphaned = false

    fun onChildCompleted() {
        if (status != AttemptOutcome.PENDING || child.noResponse) return
        status = child.outcome
        recordResponse(status)
        if (timeoutEvent.isScheduled) {
            timeoutEvent.cancel = true
        }
    }

    fun onTimeout() {
        if (status != AttemptOutcome.PENDING) return
        status = AttemptOutcome.TIMED_OUT
        orphaned = !childEnded
        recordTimeout(orphaned)
        if (child.noResponse) child.completeRouting()
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
