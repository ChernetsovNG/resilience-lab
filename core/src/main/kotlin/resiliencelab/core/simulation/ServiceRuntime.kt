package resiliencelab.core.simulation

import resiliencelab.core.scenario.DegradationSpec
import resiliencelab.core.scenario.LinkSpec
import resiliencelab.core.scenario.ServiceSpec
import ksl.modeling.entity.Allocation
import ksl.modeling.entity.AllocationListenerIfc
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.ModelElement
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.UniformRV

/**
 * Owns a service's bounded FIFO admission path, blocking handler pool, and dedicated random samplers.
 * Degradation is evaluated when local processing starts; its sampled duration and failure outcome are unaffected
 * by the degradation interval ending while that attempt continues.
 */
internal class ServiceRuntime(
    parent: ModelElement,
    private val spec: ServiceSpec,
    private val degradation: DegradationSpec?,
    streamProvider: RNStreamProvider,
    durationStreamNum: Int,
    failureStreamNum: Int,
    val outgoingLink: LinkSpec?,
    networkStreamNum: Int?,
    jitterStreamNum: Int?,
    onAdmitted: (ProcessModel.Entity) -> Unit,
    onQueueLengthChanged: (Int) -> Unit,
    onBusyHandlersChanged: (Int) -> Unit,
) {
    val serviceId: String = spec.id
    private val durationSampler = DurationSamplerFactory.create(spec.processing, durationStreamNum, streamProvider)
    private val failureSampler = UniformRV(0.0, 1.0, failureStreamNum, streamProvider)
    private val networkSampler = outgoingLink?.let {
        DurationSamplerFactory.create(it.network, requireNotNull(networkStreamNum), streamProvider)
    }
    private val jitterSampler = outgoingLink?.let {
        UniformRV(0.0, 1.0, requireNotNull(jitterStreamNum), streamProvider)
    }
    private var degradationActive = false

    val resource: ResourceWithQ
    val queue: RequestQ = BoundedRequestQ(
        parent = parent,
        name = "$serviceId:queue",
        waitingCapacity = spec.queueCapacity,
        resourceProvider = { resource },
    )

    init {
        resource = FifoResourceWithQ(
            parent = parent,
            name = serviceId,
            capacity = spec.handlers,
            queue = queue,
        )
        queue.addQueueListener(object : QueueListenerIfc<ProcessModel.Entity.Request> {
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
        })
        resource.addAllocationListener(object : AllocationListenerIfc {
            override fun allocate(allocation: Allocation) {
                onBusyHandlersChanged(resource.numBusy)
            }

            override fun deallocate(allocation: Allocation) {
                onBusyHandlersChanged(resource.numBusy)
            }
        })
    }

    fun resetDegradation() {
        degradationActive = false
    }

    fun startDegradation() {
        degradationActive = true
    }

    fun endDegradation() {
        degradationActive = false
    }

    fun nextDurationMs(): Double {
        val multiplier = if (degradationActive) degradation?.processingMultiplier ?: 1.0 else 1.0
        return durationSampler.next() * multiplier
    }

    fun nextLocalFailure(): Boolean {
        val failureRate = if (degradationActive) degradation?.failureRate ?: spec.failureRate else spec.failureRate
        return failureSampler.value < failureRate
    }

    fun nextNetworkDelayMs(): Double = requireNotNull(networkSampler).next()

    fun nextJitter(): Double = requireNotNull(jitterSampler).value
}
