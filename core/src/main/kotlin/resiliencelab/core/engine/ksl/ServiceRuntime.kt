package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.ModelElement
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep

/**
 * Owns a service's bounded FIFO admission path, blocking handler pool, and its random sources.
 * A fault is evaluated when local processing starts; its sampled duration and failure outcome are unaffected
 * by the fault interval ending while that attempt continues.
 */
internal class ServiceRuntime(
    parent: ModelElement,
    private val node: ServiceNode,
    streams: StreamSource,
    val scenario: List<ServiceStep>,
    onAdmitted: (ProcessModel.Entity) -> Unit,
    onQueueLengthChanged: (Int) -> Unit,
    onBusyHandlersChanged: (Int) -> Unit,
    onServerQueueLengthChanged: (Int) -> Unit = {},
    onBusyServerConnectionsChanged: (Int) -> Unit = {},
) {
    val serviceId: String = node.path
    private val processingStream = streams.stream(node.pathSegments, StreamRole.PROCESSING)
    private val durationSamplers =
        (listOf(node.processing) + scenario.filterIsInstance<ServiceStep.Process>().mapNotNull { it.processing })
            .associateWith { DurationSamplerFactory.create(it, processingStream) }
    private val outcomeStream = if (node.pooler == null) streams.stream(node.pathSegments, StreamRole.OUTCOME) else null
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
    val serverSlots =
        node.pooler?.let { pooler ->
            SlotPool(
                parent = parent,
                name = "$serviceId:server",
                initialCapacity = pooler.poolSize,
                queueCapacity = Int.MAX_VALUE,
                waitLimitMs = pooler.waitTimeoutMs,
                onQueueLengthChanged = onServerQueueLengthChanged,
                onBusyChanged = onBusyServerConnectionsChanged,
            )
        }
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

    fun nextDurationMs(step: ServiceStep.Process): Double =
        durationSamplers.getValue(step.processing ?: node.processing).next() * (activeFault?.processingMultiplier ?: 1.0)

    fun nextLocalFailure(step: ServiceStep.Process): Boolean {
        val failureProbability = activeFault?.failureProbability ?: step.failureProbability ?: node.failureProbability
        return outcomeStream?.randU01()?.let { it < failureProbability } ?: false
    }
}
