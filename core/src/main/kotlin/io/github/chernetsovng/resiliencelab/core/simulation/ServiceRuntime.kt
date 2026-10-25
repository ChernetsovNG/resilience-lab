package io.github.chernetsovng.resiliencelab.core.simulation

import io.github.chernetsovng.resiliencelab.core.scenario.LinkSpec
import io.github.chernetsovng.resiliencelab.core.scenario.ServiceSpec
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.ModelElement
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.UniformRV

internal class ServiceRuntime(
    parent: ModelElement,
    private val spec: ServiceSpec,
    streamProvider: RNStreamProvider,
    durationStreamNum: Int,
    failureStreamNum: Int,
    val outgoingLink: LinkSpec?,
    networkStreamNum: Int?,
    onAdmitted: (ProcessModel.Entity) -> Unit,
) {
    val serviceId: String = spec.id
    private val durationSampler = DurationSamplerFactory.create(spec.processing, durationStreamNum, streamProvider)
    private val failureSampler = UniformRV(0.0, 1.0, failureStreamNum, streamProvider)
    private val networkSampler = outgoingLink?.let {
        DurationSamplerFactory.create(it.network, requireNotNull(networkStreamNum), streamProvider)
    }

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
                if (status == Queue.Status.ENQUEUED && qObject != null) {
                    onAdmitted(qObject.entity)
                }
            }
        })
    }

    fun nextDurationMs(): Double = durationSampler.next()

    fun nextLocalFailure(): Boolean = failureSampler.value < spec.failureRate

    fun nextNetworkDelayMs(): Double = requireNotNull(networkSampler).next()
}
