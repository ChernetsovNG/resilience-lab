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
    val faults = FaultState()

    fun resetFaults() {
        faults.clear()
    }

    fun startFault(fault: FaultSpan) {
        faults.start(fault)
    }

    fun endFault(fault: FaultSpan) {
        faults.end(fault)
    }

    fun nextNetworkDelayMs(routeFaults: List<FaultState> = emptyList()): Double {
        val multiplier = routeFaults.fold(faults.multiplier) { value, state -> value * state.multiplier }
        val delayMs = routeFaults.fold(faults.delayMs) { value, state -> value + state.delayMs }
        return networkSampler.next() * multiplier + delayMs
    }

    /** Sample once at request transmission; a rejected transmission offers no work to the service. */
    fun nextTransmissionFailed(): Boolean = faults.failureProbability?.let { outcomeStream.randU01() < it } ?: false

    fun nextJitter(): Double = jitterStream.randU01()
}
