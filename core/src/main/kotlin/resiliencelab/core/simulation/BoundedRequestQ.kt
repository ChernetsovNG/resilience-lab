package resiliencelab.core.simulation

import ksl.modeling.entity.Allocation
import ksl.modeling.entity.AllocationListenerIfc
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.Resource
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.ModelElement

/**
 * Creates a FIFO request queue with a bounded number of waiting requests.
 * A request can still bypass the empty queue for immediate allocation; otherwise overflow is removed and rejected
 * with [QueueFullException]. Waiting capacity is separate from the resource's handler capacity.
 */
fun BoundedRequestQ(
    parent: ModelElement,
    name: String?,
    waitingCapacity: Int,
    resourceProvider: () -> Resource,
): RequestQ {
    val queue = RequestQ(parent, name, Queue.Discipline.FIFO)
    queue.addQueueListener(AdmissionListener(waitingCapacity, resourceProvider))
    return queue
}

private class AdmissionListener(
    private val waitingCapacity: Int,
    private val resourceProvider: () -> Resource,
) : QueueListenerIfc<ProcessModel.Entity.Request> {
    override fun update(
        status: Queue.Status,
        queue: Queue<ProcessModel.Entity.Request>,
        qObject: ProcessModel.Entity.Request?,
    ) {
        if (status != Queue.Status.ENQUEUED || qObject == null) return
        val preInsertionCount = queue.size - 1
        if (preInsertionCount >= waitingCapacity &&
            !(preInsertionCount == 0 && resourceProvider().canAllocate(qObject.amountRequested))
        ) {
            queue.remove(qObject, waitStats = false)
            throw QueueFullException(qObject.resource.name)
        }
    }
}

/**
 * Preserves FIFO handler allocation by preventing later requests from bypassing an earlier unsatisfied request.
 * The allocation-pending state permits the selected head request to complete its handoff without blocking itself.
 */
class FifoResourceWithQ(
    parent: ModelElement,
    name: String?,
    capacity: Int,
    queue: RequestQ,
) : ResourceWithQ(parent, name, capacity, queue) {
    private val requestQ = queue
    private var allocationPending = false
    private var queryingNonPendingRequests = false

    init {
        waitingQ.addQueueListener(object : QueueListenerIfc<ProcessModel.Entity.Request> {
            override fun update(
                status: Queue.Status,
                queue: Queue<ProcessModel.Entity.Request>,
                qObject: ProcessModel.Entity.Request?,
            ) {
                allocationPending = status == Queue.Status.DEQUEUED
            }
        })
        addAllocationListener(object : AllocationListenerIfc {
            override fun allocate(allocation: Allocation) {
                allocationPending = false
            }

            override fun deallocate(allocation: Allocation) = Unit
        })
    }

    override val numAvailableUnits: Int
        get() {
            if (queryingNonPendingRequests) return Int.MAX_VALUE
            val available = super.numAvailableUnits
            if (allocationPending) return available
            val head = firstNonPendingRequest() ?: return available
            return if (head.amountRequested <= available) available else 0
        }

    private fun firstNonPendingRequest(): ProcessModel.Entity.Request? {
        queryingNonPendingRequests = true
        return try {
            requestQ.filterRequestsByResource(this).firstOrNull()
        } finally {
            queryingNonPendingRequests = false
        }
    }
}
