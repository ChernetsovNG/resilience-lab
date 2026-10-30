package resiliencelab.core.ir

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import kotlin.math.PI
import kotlin.test.Test

class LoadProfileTest {
    @Test
    fun `tiny finite segments do not overflow the stationary point ratio`() {
        val profile =
            LoadProfile(
                listOf(LoadPoint(0.0, 0.0), LoadPoint(1e-308, 0.002)),
                LoadSinusoid(0.001, 1e-308, PI),
            )

        assertThat(profile.minimum(1e-308)).isLessThan(-0.0005)
        assertThat(profile.maximum(1e-308)).isGreaterThan(0.0025)
    }

    @Test
    fun `large finite periods retain interior extrema without modulo overflow`() {
        val profile = LoadProfile(listOf(LoadPoint(0.0, 0.001)), LoadSinusoid(0.002, 1.7e308))

        assertThat(profile.minimum(1.6e308)).isCloseTo(-0.001, offset(1e-17))
        assertThat(profile.maximum(1.6e308)).isCloseTo(0.003, offset(1e-17))
        val shifted = profile.copy(sinusoid = LoadSinusoid(0.002, 1.7e308, -PI / 2))
        assertThat(shifted.minimum(1.6e308)).isCloseTo(-0.001, offset(1e-17))
        assertThat(shifted.maximum(1.6e308)).isCloseTo(0.003, offset(1e-17))
    }

    @Test
    fun `large finite phases retain accurate trigonometric argument reduction`() {
        val profile = LoadProfile(listOf(LoadPoint(0.0, 0.002)), LoadSinusoid(0.001, 1_000.0, 1e16))

        assertThat(profile.rateAt(0.0)).isCloseTo(0.0027796880066069787, offset(1e-17))
        assertThat(profile.minimum(1_000.0)).isCloseTo(0.001, offset(1e-17))
        assertThat(profile.maximum(1_000.0)).isCloseTo(0.003, offset(1e-17))
    }

    @Test
    fun `interpolates and holds the nearest endpoint outside the points`() {
        val profile = LoadProfile(listOf(LoadPoint(1_000.0, 0.1), LoadPoint(3_000.0, 0.3)))

        assertThat(listOf(0.0, 1_000.0, 2_000.0, 3_000.0, 4_000.0).map(profile::rateAt))
            .containsExactly(0.1, 0.1, 0.2, 0.3, 0.3)
        assertThat(profile.average(4_000.0)).isCloseTo(0.2, offset(1e-14))
        assertThat(profile.maximum(2_000.0)).isCloseTo(0.2, offset(1e-14))
    }

    @Test
    fun `sinusoid bounds and average respect the actual run interval and phase`() {
        val profile = LoadProfile(listOf(LoadPoint(0.0, 0.2)), LoadSinusoid(0.1, 4_000.0))

        assertThat(profile.minimum(1_000.0)).isCloseTo(0.2, offset(1e-14))
        assertThat(profile.maximum(1_000.0)).isCloseTo(0.3, offset(1e-14))
        assertThat(profile.average(1_000.0)).isCloseTo(0.26366197723675815, offset(1e-14))
        assertThat(profile.minimum(4_000.0)).isCloseTo(0.1, offset(1e-14))
        assertThat(profile.average(4_000.0)).isCloseTo(0.2, offset(1e-14))
        val shifted = profile.copy(sinusoid = LoadSinusoid(0.1, 4_000.0, -PI / 2))
        assertThat(shifted.rateAt(0.0)).isCloseTo(0.1, offset(1e-14))
    }

    @Test
    fun `minimum checks the sum rather than independent component bounds`() {
        val profile =
            LoadProfile(
                listOf(LoadPoint(0.0, 0.0), LoadPoint(1_000.0, 10.0)),
                LoadSinusoid(1.0, 1_000.0),
            )

        assertThat(profile.minimum(1_000.0)).isZero()
        assertThat(profile.maximum(1_000.0)).isEqualTo(10.0)
        assertThat(profile.average(1_000.0)).isEqualTo(5.0)
    }

    @Test
    fun `many periods find stationary extrema without scanning every cycle`() {
        val profile = LoadProfile(listOf(LoadPoint(0.0, 2.0)), LoadSinusoid(1.0, 1.0))

        assertThat(profile.minimum(1e12)).isEqualTo(1.0)
        assertThat(profile.maximum(1e12)).isEqualTo(3.0)
        assertThat(profile.average(1e12)).isEqualTo(2.0)
    }
}
