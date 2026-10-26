package resiliencelab.core.simulation

import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import ksl.utilities.random.rvariable.LognormalRV
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import kotlin.test.Test

class DurationSamplerTest {
    @Test
    fun `fixed sampler returns configured millisecond value for every draw`() {
        val sampler =
            DurationSamplerFactory.create(
                DurationDistribution(DistributionKind.FIXED, meanMs = 12.5, stdDevMs = null),
                streamNum = 7,
                provider = RNStreamProvider(),
            )

        val samples = DoubleArray(8) { sampler.next() }

        assertThat(samples).containsExactly(*DoubleArray(8) { 12.5 })
    }

    @Test
    fun `exponential sampler matches KSL for configured mean and stream`() {
        val meanMs = 25.0
        val streamNum = 3
        val expected = ExponentialRV(meanMs, streamNum, seededProvider())
        val sampler =
            DurationSamplerFactory.create(
                DurationDistribution(DistributionKind.EXPONENTIAL, meanMs, stdDevMs = null),
                streamNum,
                seededProvider(),
            )

        val expectedSamples = DoubleArray(16) { expected.value }
        val actualSamples = DoubleArray(16) { sampler.next() }

        assertThat(actualSamples).containsExactly(*expectedSamples)
    }

    @Test
    fun `lognormal sampler converts standard deviation to KSL variance`() {
        val meanMs = 40.0
        val stdDevMs = 6.0
        val streamNum = 4
        val expected = LognormalRV(meanMs, stdDevMs * stdDevMs, streamNum, seededProvider())
        val sampler =
            DurationSamplerFactory.create(
                DurationDistribution(DistributionKind.LOGNORMAL, meanMs, stdDevMs),
                streamNum,
                seededProvider(),
            )

        val expectedSamples = DoubleArray(16) { expected.value }
        val actualSamples = DoubleArray(16) { sampler.next() }

        assertThat(actualSamples).containsExactly(*expectedSamples)
    }

    @Test
    fun `lognormal samplers repeat sequence with independently seeded providers`() {
        val spec = DurationDistribution(DistributionKind.LOGNORMAL, meanMs = 40.0, stdDevMs = 6.0)
        val first = DurationSamplerFactory.create(spec, streamNum = 4, provider = seededProvider())
        val second = DurationSamplerFactory.create(spec, streamNum = 4, provider = seededProvider())

        val firstSamples = DoubleArray(16) { first.next() }
        val secondSamples = DoubleArray(16) { second.next() }

        assertThat(secondSamples).containsExactly(*firstSamples)
    }

    private fun seededProvider(): RNStreamProvider =
        RNStreamProvider().apply {
            initialSeed(longArrayOf(101L, 202L, 303L, 404L, 505L, 606L))
        }
}
