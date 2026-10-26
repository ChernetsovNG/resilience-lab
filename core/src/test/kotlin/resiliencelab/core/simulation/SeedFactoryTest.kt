package resiliencelab.core.simulation

import ksl.utilities.random.rng.RNStreamProvider
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class SeedFactoryTest {
    @Test
    fun `seed 42 produces six non-zero values accepted by KSL`() {
        val seeds = SeedFactory.seedVector(42L)

        assertEquals(6, seeds.size)
        assertTrue(seeds.take(3).all { it in 1L until 4294967087L }, seeds.contentToString())
        assertTrue(seeds.drop(3).all { it in 1L until 4294944443L }, seeds.contentToString())
        assertTrue(seeds.none { it == 0L }, seeds.contentToString())
        RNStreamProvider().initialSeed(seeds)
    }

    @Test
    fun `same seed returns identical vectors across calls`() {
        assertContentEquals(SeedFactory.seedVector(42L), SeedFactory.seedVector(42L))
    }

    @Test
    fun `different seeds return different vectors`() {
        assertNotEquals(SeedFactory.seedVector(42L).toList(), SeedFactory.seedVector(43L).toList())
    }

    @Test
    fun `seed vector follows the independently constructed Kotlin random sequence`() {
        val random = Random(42L)
        val expected = LongArray(6) { index ->
            val upperBound = if (index < 3) 4294967087L else 4294944443L
            random.nextLong(1L, upperBound)
        }

        assertContentEquals(expected, SeedFactory.seedVector(42L))
    }
}
