package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import kotlin.math.sqrt
import kotlin.test.Test

class LoadProfileArrivalsTest {
    private fun run(
        load: LoadProfile,
        replication: Int = 0,
    ): List<Double> {
        val base = TestChains.simple()
        val graph =
            base.copy(
                client = base.client.copy(load = load),
                services = listOf(base.services.first().copy(handlers = 100, processing = TestChains.fixed(0.0))),
                calls = emptyList(),
                run = base.run.copy(measurementMs = 4_000.0),
            )
        return TestChains
            .reliabilityModel(Model("LoadProfileTest", autoCSVReports = false), graph, replication)
            .runReplication()
            .arrivalTimesMs
    }

    @Test
    fun `step and ramp window counts converge within Poisson uncertainty`() {
        val step =
            LoadProfile(
                listOf(
                    LoadPoint(0.0, 0.5),
                    LoadPoint(1_999.999, 0.5),
                    LoadPoint(2_000.0, 1.5),
                ),
            )
        val ramp = LoadProfile(listOf(LoadPoint(0.0, 0.0), LoadPoint(4_000.0, 2.0)))
        listOf(
            step to listOf(500.0, 500.0, 1_500.0, 1_500.0),
            ramp to listOf(250.0, 750.0, 1_250.0, 1_750.0),
        ).forEach { (profile, expectations) ->
            val arrivals = (0 until 8).flatMap { run(profile, it) }
            expectations.forEachIndexed { window, expected ->
                val count = arrivals.count { it >= window * 1_000.0 && it < (window + 1) * 1_000.0 }
                assertThat(count.toDouble())
                    .describedAs("%s, window %s", profile, window)
                    .isCloseTo(expected * 8, offset(6 * sqrt(expected * 8)))
            }
        }
    }

    @Test
    fun `constant arrival times remain bitwise identical and zero load drains`() {
        assertThat(run(LoadProfile.constant(0.1)))
            .isEqualTo(TestChains.expectedArrivals(42, 0.1, 4_000.0))
        assertThat(run(LoadProfile(listOf(LoadPoint(0.0, 0.1), LoadPoint(1_000.0, 0.1)))))
            .isEqualTo(TestChains.expectedArrivals(42, 0.1, 4_000.0))
        assertThat(run(LoadProfile.constant(0.0))).isEmpty()
    }

    @Test
    fun `acceptance role remains stable when another element is added`() {
        val graph =
            TestChains.simple().let {
                it.copy(
                    client =
                        it.client.copy(
                            load = LoadProfile(listOf(LoadPoint(0.0, 0.1), LoadPoint(1_000.0, 0.2))),
                        ),
                )
            }
        val extra = graph.copy(services = graph.services + graph.services.last().copy(pathSegments = listOf("extra")))
        val first = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), 42, 0)
        val second = PathStreamSource(StreamPlan(PathStreams.keys(extra, 0)), 42, 0)
        listOf(StreamRole.ARRIVALS, StreamRole.ARRIVAL_ACCEPTANCE).forEach { role ->
            val a = first.stream("client", role)
            val b = second.stream("client", role)
            assertThat(DoubleArray(16) { a.randU01() }).containsExactly(*DoubleArray(16) { b.randU01() })
        }
    }
}
