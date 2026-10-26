package resiliencelab.core.simulation

import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ConstantRV
import ksl.utilities.random.rvariable.ExponentialRV
import ksl.utilities.random.rvariable.LognormalRV

fun interface DurationSampler {
    fun next(): Double
}

object DurationSamplerFactory {
    fun create(spec: DurationDistribution, streamNum: Int, provider: RNStreamProvider): DurationSampler {
        val randomVariable = when (spec.kind) {
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
