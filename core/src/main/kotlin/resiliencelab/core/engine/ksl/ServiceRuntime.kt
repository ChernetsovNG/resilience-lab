package resiliencelab.core.engine.ksl

import ksl.modeling.entity.Allocation
import ksl.modeling.entity.AllocationListenerIfc
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.ModelElement
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.ServiceNode

/**
 * Owns a service's bounded FIFO admission path, blocking handler pool, and its random sources.
 * A fault is evaluated when local processing starts; its sampled duration and failure outcome are unaffected
 * by the fault interval ending while that attempt continues.
 */
internal class ServiceRuntime(
    parent: ModelElement,
    private val node: ServiceNode,
    streams: StreamSource,
    val outgoingCall: CallEdge?,
    onAdmitted: (ProcessModel.Entity) -> Unit,
    onQueueLengthChanged: (Int) -> Unit,
    onBusyHandlersChanged: (Int) -> Unit,
) {
    val serviceId: String = node.path
    private val durationSampler =
        DurationSamplerFactory.create(node.processing, streams.stream(node.path, StreamRole.PROCESSING))
    private val outcomeStream = streams.stream(node.path, StreamRole.OUTCOME)
    private val networkSampler =
        outgoingCall?.let { DurationSamplerFactory.create(it.network, streams.stream(it.path, StreamRole.NETWORK)) }
    private val jitterStream = outgoingCall?.let { streams.stream(it.path, StreamRole.JITTER) }
    private var activeFault: FaultSpan? = null

    val resource: ResourceWithQ
    val queue: RequestQ =
        BoundedRequestQ(
            parent = parent,
            name = "$serviceId:queue",
            waitingCapacity = node.queueCapacity,
            resourceProvider = { resource },
        )

    init {
        resource =
            FifoResourceWithQ(
                parent = parent,
                name = serviceId,
                capacity = node.handlers,
                queue = queue,
            )
        queue.addQueueListener(
            object : QueueListenerIfc<ProcessModel.Entity.Request> {
                override fun update(
                    status: Queue.Status,
                    queue: Queue<ProcessModel.Entity.Request>,
                    qObject: ProcessModel.Entity.Request?,
                ) {
                    onQueueLengthChanged(queue.size)
                    if (status == Queue.Status.ENQUEUED && qObject != null) {
                        onAdmitted(qObject.entity)
                    }
                }
            },
        )
        resource.addAllocationListener(
            object : AllocationListenerIfc {
                override fun allocate(allocation: Allocation) {
                    onBusyHandlersChanged(resource.numBusy)
                }

                override fun deallocate(allocation: Allocation) {
                    onBusyHandlersChanged(resource.numBusy)
                }
            },
        )
    }

    fun resetFaults() {
        activeFault = null
    }

    fun startFault(fault: FaultSpan) {
        activeFault = fault
    }

    fun endFault(fault: FaultSpan) {
        if (activeFault == fault) activeFault = null
    }

    fun nextDurationMs(): Double = durationSampler.next() * (activeFault?.processingMultiplier ?: 1.0)

    fun nextLocalFailure(): Boolean {
        val failureProbability = activeFault?.failureProbability ?: node.failureProbability
        return outcomeStream.randU01() < failureProbability
    }

    fun nextNetworkDelayMs(): Double = requireNotNull(networkSampler).next()

    fun nextJitter(): Double = requireNotNull(jitterStream).randU01()
}
