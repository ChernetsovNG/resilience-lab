package resiliencelab.research.streams

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import ksl.utilities.random.rng.RNStreamFactory
import kotlin.random.Random
import kotlin.test.Test

class PathStreamsTest {
    private val base = StreamKey(42, 0, listOf("system", "api"), "processing")

    @Test
    fun `distinct paths roles seeds and repetitions have distinct addresses and prefixes`() {
        val keys = listOf(base, base.copy(seed = 43), base.copy(replication = 1),
            base.copy(path = listOf("system", "db")), base.copy(role = "outcome"))
        val plan = StreamPlan(keys)
        assertThat(plan.addresses.values.toSet()).hasSize(keys.size)
        val prefixes = plan.open(keys).values.map { stream -> List(16) { stream.randU01().toBits() } }
        assertThat(prefixes.toSet()).hasSize(keys.size)
    }

    @Test
    fun `permutation insertion deletion and variant union preserve common source bits`() {
        val keys = (0..19).map { base.copy(path = listOf("system", "service$it")) }
        fun samples(input: List<StreamKey>) = StreamPlan(input).open(input).mapValues { (_, stream) ->
            List(128) { stream.randU01().toBits() }
        }
        val baseline = samples(keys)
        assertThat(samples(keys.shuffled(Random(7)))).isEqualTo(baseline)
        val extra = base.copy(path = listOf("system", "unrelated"))
        assertThat(samples(listOf(extra) + keys).filterKeys { it != extra }).isEqualTo(baseline)
        assertThat(samples(keys.drop(1))).isEqualTo(baseline.filterKeys { it != keys.first() })
        val union = StreamPlan(keys + keys + extra)
        val firstVariant = union.open(keys)
        val secondVariant = union.open(keys.reversed() + extra)
        for (key in keys) {
            assertThat(firstVariant.getValue(key)).isNotSameAs(secondVariant.getValue(key))
            assertThat(List(128) { firstVariant.getValue(key).randU01().toBits() })
                .isEqualTo(List(128) { secondVariant.getValue(key).randU01().toBits() })
        }
    }

    @Test
    fun `encoding distinguishes segment boundaries field boundaries and Unicode`() {
        val keys = listOf(
            base.copy(path = listOf("a/b", "c")),
            base.copy(path = listOf("a", "b/c")),
            base.copy(path = listOf("a"), role = "b/c"),
            base.copy(path = listOf("а", "сервис")),
            base.copy(path = listOf("é")),
            base.copy(path = listOf("e\u0301")),
            base.copy(seed = 0, replication = Long.MAX_VALUE),
            base.copy(seed = 9_007_199_254_740_991),
        )
        assertThat(keys.map(::addressOf).toSet()).hasSize(keys.size)
        assertThat(keys.map(::addressOf)).allMatch { it >= 0 }
    }

    @Test
    fun `invalid identities fail before allocation`() {
        val invalid = listOf(
            base.copy(seed = -1), base.copy(seed = 9_007_199_254_740_992),
            base.copy(replication = -1), base.copy(path = emptyList()),
            base.copy(path = listOf("")), base.copy(role = ""),
            base.copy(path = listOf("\uD800")),
        )
        invalid.forEach { key ->
            assertThatThrownBy { StreamPlan(listOf(key)) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `collision preflight rejects different full keys and accepts intentional CRN reuse`() {
        val other = base.copy(replication = 1)
        assertThat(checkAddresses(listOf(base to 123L, base to 123L))).hasSize(1)
        assertThatThrownBy { checkAddresses(listOf(base to 123L, other to 123L)) }
            .isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("collision")
    }

    @Test
    fun `scope rejects undeclared and duplicate keys and lookup does not reset`() {
        val plan = StreamPlan(listOf(base))
        assertThatThrownBy { plan.open(listOf(base.copy(replication = 1))) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { plan.open(listOf(base, base)) }
            .isInstanceOf(IllegalArgumentException::class.java)
        val scope = plan.open(listOf(base))
        val reference = plan.open(listOf(base)).getValue(base)
        repeat(16) { assertThat(scope.getValue(base).randU01().toBits()).isEqualTo(reference.randU01().toBits()) }
    }

    @Test
    fun `small addressed jumps agree with repeated native advancement`() {
        for (slot in listOf(0L, 1L, 2L, 17L, 100L)) {
            val reference = RNStreamFactory().nextStream()
            repeat(slot.toInt()) { reference.advanceToNextSubStream() }
            val addressed = streamAt(slot)
            assertThat(List(128) { addressed.randU01().toBits() })
                .isEqualTo(List(128) { reference.randU01().toBits() })
        }
    }
}
