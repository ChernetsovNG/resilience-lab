package resiliencelab.core.simulation

import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ConstantRV
import ksl.utilities.random.rvariable.ExponentialRV
import ksl.utilities.random.rvariable.LognormalRV
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution

/** Draws processing or one-way network durations in milliseconds from a configured distribution. */
fun interface DurationSampler {
    fun next(): Double
}

/** Binds duration distributions to their designated KSL streams; fixed durations consume no random stream. */
object DurationSamplerFactory {
    fun create(
        spec: DurationDistribution,
        streamNum: Int,
        provider: RNStreamProvider,
    ): DurationSampler {
        val randomVariable =
            when (spec.kind) {
                DistributionKind.FIXED -> ConstantRV(spec.meanMs)
                DistributionKind.EXPONENTIAL -> ExponentialRV(spec.meanMs, streamNum, provider)
                DistributionKind.LOGNORMAL -> {
                    val stdDev = spec.stdDevMs!!
                    LognormalRV(spec.meanMs, stdDev * stdDev, streamNum, provider)
                }
            }
        return DurationSampler { randomVariable.value }
    }
}
