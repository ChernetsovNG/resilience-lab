package resiliencelab.core.engine.ksl

import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import ksl.utilities.random.rvariable.LognormalRV
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import kotlin.test.Test

class DurationSamplerTest {
    @Test
    fun `fixed sampler returns configured millisecond value for every draw`() {
        val sampler = DurationSamplerFactory.create(Distribution(DistributionShape.FIXED, 12.5), RNStreamProvider().rnStream(7))

        assertThat(DoubleArray(8) { sampler.next() }).containsExactly(*DoubleArray(8) { 12.5 })
    }

    @Test
    fun `exponential sampler matches KSL for configured mean and stream`() {
        val expected = ExponentialRV(25.0, 3, seededProvider())
        val sampler = DurationSamplerFactory.create(Distribution(DistributionShape.EXPONENTIAL, 25.0), seededProvider().rnStream(3))

        val expectedSamples = DoubleArray(16) { expected.value }

        assertThat(DoubleArray(16) { sampler.next() }).containsExactly(*expectedSamples)
    }

    @Test
    fun `lognormal sampler converts standard deviation to KSL variance`() {
        val expected = LognormalRV(40.0, 6.0 * 6.0, 4, seededProvider())
        val sampler =
            DurationSamplerFactory.create(Distribution(DistributionShape.LOGNORMAL, 40.0, 6.0), seededProvider().rnStream(4))

        val expectedSamples = DoubleArray(16) { expected.value }

        assertThat(DoubleArray(16) { sampler.next() }).containsExactly(*expectedSamples)
    }

    @Test
    fun `lognormal samplers repeat sequence with independently seeded providers`() {
        val distribution = Distribution(DistributionShape.LOGNORMAL, 40.0, 6.0)
        val first = DurationSamplerFactory.create(distribution, seededProvider().rnStream(4))
        val second = DurationSamplerFactory.create(distribution, seededProvider().rnStream(4))

        val firstSamples = DoubleArray(16) { first.next() }

        assertThat(DoubleArray(16) { second.next() }).containsExactly(*firstSamples)
    }

    private fun seededProvider(): RNStreamProvider =
        RNStreamProvider().apply {
            initialSeed(longArrayOf(101L, 202L, 303L, 404L, 505L, 606L))
        }
}
