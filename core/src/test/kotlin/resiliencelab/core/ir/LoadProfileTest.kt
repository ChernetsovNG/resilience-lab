package resiliencelab.core.ir

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import kotlin.test.Test

class LoadProfileTest {
    @Test
    fun `interpolates and holds the nearest endpoint outside the points`() {
        val profile = LoadProfile(listOf(LoadPoint(1_000.0, 0.1), LoadPoint(3_000.0, 0.3)))
        assertThat(listOf(0.0, 1_000.0, 2_000.0, 3_000.0, 4_000.0).map(profile::rateAt))
            .containsExactly(0.1, 0.1, 0.2, 0.3, 0.3)
        assertThat(profile.average(4_000.0)).isCloseTo(0.2, offset(1e-14))
    }

    @Test
    fun `maximum and mean include partial segments but exclude future peaks`() {
        val profile =
            LoadProfile(
                listOf(
                    LoadPoint(0.0, 0.1),
                    LoadPoint(1_000.0, 0.3),
                    LoadPoint(2_000.0, 0.0),
                    LoadPoint(3_000.0, 1.0),
                ),
            )
        assertThat(profile.maximum(500.0)).isCloseTo(0.2, offset(1e-14))
        assertThat(profile.average(500.0)).isCloseTo(0.15, offset(1e-14))
        assertThat(profile.maximum(2_000.0)).isEqualTo(0.3)
        assertThat(profile.average(2_000.0)).isCloseTo(0.175, offset(1e-14))
    }

    @Test
    fun `equal points retain constant intensity bits without integration rounding`() {
        val profile = LoadProfile(listOf(LoadPoint(0.0, 0.12), LoadPoint(1_000.0, 0.12)))
        assertThat(profile.isConstant).isTrue()
        assertThat(profile.average(123.45).toBits()).isEqualTo(0.12.toBits())
        assertThat(profile.maximum(123.45).toBits()).isEqualTo(0.12.toBits())
    }
}
