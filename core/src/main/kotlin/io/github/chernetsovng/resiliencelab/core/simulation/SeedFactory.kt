package io.github.chernetsovng.resiliencelab.core.simulation

import kotlin.random.Random

object SeedFactory {
    fun seedVector(seed: Long): LongArray {
        val random = Random(seed)
        return LongArray(6) { index ->
            val upperBound = if (index < 3) 4294967087L else 4294944443L
            random.nextLong(1L, upperBound)
        }
    }
}
