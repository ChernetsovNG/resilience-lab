package resiliencelab.core.lab

import org.assertj.core.api.Assertions.assertThat
import java.time.Instant
import kotlin.random.Random
import kotlin.test.Test

class RunIdsTest {
    @Test
    fun `formats UTC time with a hexadecimal suffix`() {
        assertThat(RunIds.next(Instant.parse("2026-10-27T15:30:12.345Z"), Random(1)))
            .matches("20261027-153012-345-[0-9a-f]{4}")
    }

    @Test
    fun `ids sort by start time`() {
        val earlier = RunIds.next(Instant.parse("2026-10-27T09:00:00Z"), Random(1))
        val later = RunIds.next(Instant.parse("2026-10-27T10:00:00Z"), Random(2))

        assertThat(earlier).isLessThan(later)
    }
}
