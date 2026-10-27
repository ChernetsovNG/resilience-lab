package resiliencelab.server.lab

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class IfMatchTest {
    @Test
    fun `compares entity tags strongly`() {
        assertThat(IfMatch.accepts("\"v1\"", "v1")).isTrue()
        assertThat(IfMatch.accepts("\"v0\", \"v1\"", "v1")).isTrue()
        assertThat(IfMatch.accepts("*", "v1")).isTrue()
        assertThat(IfMatch.accepts("W/\"v1\"", "v1")).isFalse()
        assertThat(IfMatch.accepts("v1", "v1")).isFalse()
        assertThat(IfMatch.accepts("\"v2\"", "v1")).isFalse()
    }
}
