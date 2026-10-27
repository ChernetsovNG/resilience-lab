package resiliencelab.core.simulation

import ksl.utilities.random.rng.RNStreamIfc
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.KSLRandom
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.scenario.DurationDistribution

/** Draws processing or one-way network durations in milliseconds from a configured distribution. */
fun interface DurationSampler {
    fun next(): Double
}

/** Draws durations from an explicitly owned stream; fixed durations consume no random numbers (ADR 0006). */
object DurationSamplerFactory {
    fun create(
        distribution: Distribution,
        stream: RNStreamIfc,
    ): DurationSampler =
        when (distribution.shape) {
            DistributionShape.FIXED -> DurationSampler { distribution.meanMs }
            DistributionShape.EXPONENTIAL -> DurationSampler { KSLRandom.rExponential(distribution.meanMs, stream) }
            DistributionShape.LOGNORMAL -> {
                val stdDev = requireNotNull(distribution.stdDevMs) { "Lognormal distribution requires stdDevMs" }
                DurationSampler { KSLRandom.rLogNormal(distribution.meanMs, stdDev * stdDev, stream) }
            }
        }

    /** MVP overload; removed with the `scenario` package. */
    fun create(
        spec: DurationDistribution,
        streamNum: Int,
        provider: RNStreamProvider,
    ): DurationSampler = create(LegacyScenarioAdapter.distribution(spec), provider.rnStream(streamNum))
}
