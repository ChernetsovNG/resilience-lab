package resiliencelab.core.engine.ksl

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.PoolerSettings
import resiliencelab.core.ir.RouteEdge
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

    @Test
    fun `graph sources retain explicit instance path segments`() {
        val original = TestChains.simple()
        val graph =
            original.copy(
                entry = "entry#2",
                calls = original.calls.map { it.copy(from = "entry#2") },
                services =
                    original.services.map {
                        if (it.path == "entry") it.copy(pathSegments = listOf("entry", "#2")) else it
                    },
            )
        val keys = PathStreams.keys(graph, 0)
        assertThat(keys.filter { it.path == listOf("entry", "#2") }.map { it.role })
            .containsExactly("processing", "outcome")
        assertThat(keys.filter { it.path == listOf("backend") })
            .containsExactlyElementsOf(PathStreams.keys(original, 0).filter { it.path == listOf("backend") })
        val model = ksl.simulation.Model("SegmentedPathTest", autoCSVReports = false)
        assertThat(TestChains.reliabilityModel(model, graph).runReplication().originalArrivals).isPositive()
    }

    @Test
    fun `route and pooler error sources stay independent when another fault source is added`() {
        val original = TestChains.simple()
        val graph =
            original.copy(
                services = original.services.map { if (it.path == "backend") it.copy(pooler = PoolerSettings(1, 20.0)) else it },
                routes = listOf(RouteEdge("route", "router", "backend")),
                faults = listOf("backend", "route").map { FaultSpan(it, 0.0, 10.0, FaultKind.ERRORS, failureProbability = 0.5) },
            )
        val expanded =
            graph.copy(
                faults =
                    graph.faults + FaultSpan("entry-to-backend", 0.0, 10.0, FaultKind.ERRORS, failureProbability = 0.1),
            )
        val small = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), 42, 0)
        val large = PathStreamSource(StreamPlan(PathStreams.keys(expanded, 0)), 42, 0)
        for (path in listOf("entry", "backend", "route")) {
            assertThat(DoubleArray(8) { large.stream(path, StreamRole.OUTCOME).randU01() })
                .containsExactly(*DoubleArray(8) { small.stream(path, StreamRole.OUTCOME).randU01() })
        }
    }
}
