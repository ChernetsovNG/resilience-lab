package resiliencelab.core.engine.ksl

import ksl.utilities.random.rng.RNStreamProvider
import org.assertj.core.api.Assertions.assertThat
import kotlin.random.Random
import kotlin.test.Test

class SeedFactoryTest {
    @Test
    fun `seed 42 produces six non-zero values accepted by KSL`() {
        val seeds = SeedFactory.seedVector(42L)

        assertThat(seeds).hasSize(6)
        assertThat(seeds.take(3).all { it in 1L until 4294967087L }).describedAs(seeds.contentToString()).isTrue()
        assertThat(seeds.drop(3).all { it in 1L until 4294944443L }).describedAs(seeds.contentToString()).isTrue()
        assertThat(seeds.none { it == 0L }).describedAs(seeds.contentToString()).isTrue()
        RNStreamProvider().initialSeed(seeds)
    }

    @Test
    fun `same seed returns identical vectors across calls`() {
        assertThat(SeedFactory.seedVector(42L)).containsExactly(*SeedFactory.seedVector(42L))
    }

    @Test
    fun `different seeds return different vectors`() {
        assertThat(SeedFactory.seedVector(42L).toList()).isNotEqualTo(SeedFactory.seedVector(43L).toList())
    }

    @Test
    fun `seed vector follows the independently constructed Kotlin random sequence`() {
        val random = Random(42L)
        val expected =
            LongArray(6) { index ->
                val upperBound = if (index < 3) 4294967087L else 4294944443L
                random.nextLong(1L, upperBound)
            }

        assertThat(SeedFactory.seedVector(42L)).containsExactly(*expected)
    }
}
