package resiliencelab.core.simulation

import kotlin.random.Random

private const val KSL_M1_EXCLUSIVE_LIMIT = 4294967087L
private const val KSL_M2_EXCLUSIVE_LIMIT = 4294944443L
private const val KSL_GROUP_SIZE = 3

object SeedFactory {
    fun seedVector(seed: Long): LongArray {
        val random = Random(seed)
        return longArrayOf(
            *LongArray(KSL_GROUP_SIZE) { random.nextLong(1L, KSL_M1_EXCLUSIVE_LIMIT) },
            *LongArray(KSL_GROUP_SIZE) { random.nextLong(1L, KSL_M2_EXCLUSIVE_LIMIT) },
        )
    }
}
