package resiliencelab.core.ir

import kotlin.math.ceil

/**
 * Number of windows with boundaries min(endMs, k * windowMs). Correct the division estimate against the same
 * binary64 multiplication used by the collector: ceil(0.07 / 0.01) is 8 although 7 * 0.01 reaches 0.07.
 */
internal fun windowCount(
    endMs: Double,
    windowMs: Double,
): Int {
    require(endMs.isFinite() && endMs > 0.0 && windowMs.isFinite() && windowMs > 0.0) {
        "Window and observation interval must be finite positive durations"
    }
    val estimate = endMs / windowMs
    require(estimate.isFinite() && estimate <= Int.MAX_VALUE.toDouble() + 1) { "Window count exceeds ${Int.MAX_VALUE}" }
    var count = ceil(estimate).toLong().coerceAtLeast(1)
    while (count > 1 && (count - 1).toDouble() * windowMs >= endMs) count--
    while (count.toDouble() * windowMs < endMs) count++
    require(count <= Int.MAX_VALUE) { "Window count exceeds ${Int.MAX_VALUE}" }
    return count.toInt()
}
