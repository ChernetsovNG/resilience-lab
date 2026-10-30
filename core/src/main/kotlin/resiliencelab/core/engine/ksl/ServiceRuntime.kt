package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.ResourceWithQ
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
        DurationSamplerFactory.create(node.processing, streams.stream(node.pathSegments, StreamRole.PROCESSING))
    private val outcomeStream = streams.stream(node.pathSegments, StreamRole.OUTCOME)
    private val networkSampler =
        outgoingCall?.let { DurationSamplerFactory.create(it.network, streams.stream(it.pathSegments, StreamRole.NETWORK)) }
    private val jitterStream = outgoingCall?.let { streams.stream(it.pathSegments, StreamRole.JITTER) }
    private var activeFault: FaultSpan? = null

    val slots =
        SlotPool(
            parent = parent,
            name = serviceId,
            initialCapacity = node.handlers,
            queueCapacity = node.queueCapacity,
            onAdmitted = onAdmitted,
            onQueueLengthChanged = onQueueLengthChanged,
            onBusyChanged = onBusyHandlersChanged,
        )
    val resource: ResourceWithQ get() = slots.resource
    val queue: RequestQ get() = slots.queue

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
