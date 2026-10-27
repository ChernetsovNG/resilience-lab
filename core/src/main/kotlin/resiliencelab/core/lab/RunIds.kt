package resiliencelab.core.lab

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.random.Random

/**
 * Run ids shared by the server and the CLI: UTC start time to the millisecond and a random suffix, so that ids are
 * single path segments and sort by start time (ADR 0008).
 */
object RunIds {
    private val timestamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS").withZone(ZoneOffset.UTC)

    fun next(
        now: Instant = Instant.now(),
        random: Random = Random.Default,
    ): String = timestamp.format(now) + "-" + random.nextInt(0x10000).toString(16).padStart(4, '0')
}
