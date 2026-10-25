package io.github.chernetsovng.resiliencelab.core.simulation

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.Resource
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.ModelElement

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
