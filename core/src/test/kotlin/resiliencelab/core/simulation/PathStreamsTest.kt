package resiliencelab.core.simulation

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import kotlin.test.Test

class PathStreamsTest {
    private val key = StreamKey(seed = 42, replication = 0, path = listOf("system", "api"), role = "processing")

    @Test
    fun `matches the independent oracle address`() {
        assertThat(PathStreams.addressOf(key)).isEqualTo(5_391_452_259_724_126_168L)
    }

    @Test
    fun `rejects invalid keys`() {
        assertThatThrownBy { PathStreams.addressOf(key.copy(seed = -1)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(seed = 9_007_199_254_740_992)) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(replication = -1)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(path = listOf("a", ""))) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(role = "")) }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `same key gives the same sequence in separately opened sources and other roles differ`() {
        val plan = StreamPlan(listOf(key, key.copy(role = "outcome")))
        val first = PathStreamSource(plan, seed = 42, replication = 0).stream("system/api", StreamRole.PROCESSING)
        val second = PathStreamSource(plan, seed = 42, replication = 0).stream("system/api", StreamRole.PROCESSING)
        val other = PathStreamSource(plan, seed = 42, replication = 0).stream("system/api", StreamRole.OUTCOME)

        val firstValues = DoubleArray(4) { first.randU01() }
        assertThat(DoubleArray(4) { second.randU01() }).containsExactly(*firstValues)
        assertThat(DoubleArray(4) { other.randU01() }).isNotEqualTo(firstValues)
    }

    @Test
    fun `extra keys in a plan do not change existing streams`() {
        val small = StreamPlan(listOf(key))
        val large = StreamPlan(listOf(key.copy(path = listOf("other")), key))

        val fromSmall = PathStreamSource(small, 42, 0).stream("system/api", StreamRole.PROCESSING)
        val fromLarge = PathStreamSource(large, 42, 0).stream("system/api", StreamRole.PROCESSING)

        assertThat(DoubleArray(4) { fromLarge.randU01() }).containsExactly(*DoubleArray(4) { fromSmall.randU01() })
    }

    @Test
    fun `a source returns the same stream object for repeated requests`() {
        val source = PathStreamSource(StreamPlan(listOf(key)), 42, 0)
        assertThat(source.stream("system/api", StreamRole.PROCESSING)).isSameAs(source.stream("system/api", StreamRole.PROCESSING))
    }

    @Test
    fun `different keys sharing an address stop the plan but identical keys are allowed`() {
        assertThatThrownBy { StreamPlan(listOf(key, key.copy(role = "outcome"))) { 7L } }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("collision")
        assertThat(StreamPlan(listOf(key, key)).size).isEqualTo(1)
    }

    @Test
    fun `keys outside the plan are rejected`() {
        val source = PathStreamSource(StreamPlan(listOf(key)), 42, 0)
        assertThatThrownBy { source.stream("system/db", StreamRole.PROCESSING) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("absent")
    }
}
