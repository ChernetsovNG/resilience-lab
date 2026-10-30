package resiliencelab.core.engine.ksl

import resiliencelab.core.ir.CallEdge

/** Edge-owned request/response network and backoff sources, shared by its successive calls and retries. */
internal class CallRuntime(
    val edge: CallEdge,
    streams: StreamSource,
) {
    private val networkSampler =
        DurationSamplerFactory.create(edge.network, streams.stream(edge.pathSegments, StreamRole.NETWORK))
    private val jitterStream = streams.stream(edge.pathSegments, StreamRole.JITTER)

    fun nextNetworkDelayMs(): Double = networkSampler.next()

    fun nextJitter(): Double = jitterStream.randU01()
}
