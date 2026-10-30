package resiliencelab.core.engine.ksl

import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.FaultSpan

/** Edge-owned request/response network and backoff sources, shared by its successive calls and retries. */
internal class CallRuntime(
    val edge: CallEdge,
    private val streams: StreamSource,
) {
    private val networkSampler =
        DurationSamplerFactory.create(edge.network, streams.stream(edge.pathSegments, StreamRole.NETWORK))
    private val jitterStream = streams.stream(edge.pathSegments, StreamRole.JITTER)
    private val outcomeStream by lazy { streams.stream(edge.pathSegments, StreamRole.OUTCOME) }
    private var activeFault: FaultSpan? = null

    fun resetFaults() {
        activeFault = null
    }

    fun startFault(fault: FaultSpan) {
        activeFault = fault
    }

    fun endFault(fault: FaultSpan) {
        if (activeFault == fault) activeFault = null
    }

    fun nextNetworkDelayMs(): Double = networkSampler.next() * (activeFault?.processingMultiplier ?: 1.0)

    /** Sample once at request transmission; a rejected transmission offers no work to the service. */
    fun nextTransmissionFailed(): Boolean = activeFault?.failureProbability?.let { outcomeStream.randU01() < it } ?: false

    fun nextJitter(): Double = jitterStream.randU01()
}
