package resiliencelab.core.results

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class SaturationTest {
    @Test
    fun `a thirty millisecond burst does not saturate`() {
        val result = detect(listOf(hot(0.0), hot(10.0), hot(20.0)))

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `one hundred milliseconds of pressure saturate at the first window`() {
        val result = detect((0 until 10).map { hot(it * 10.0) })

        assertThat(result).isEqualTo(ReplicationSaturation(0, listOf(SaturatedNode("service", 0.0))))
    }

    @Test
    fun `a cold window breaks the pressure interval`() {
        val result =
            detect(
                listOf(
                    row(0.0, durationMs = 60.0),
                    row(60.0, utilization = 0.94),
                    row(70.0, durationMs = 50.0),
                    row(120.0, durationMs = 50.0),
                ),
            )

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 70.0))
    }

    @Test
    fun `an isolated queue rejection does not bypass the minimum duration`() {
        listOf(10.0, 50.0, 100.0, 200.0).forEach { durationMs ->
            val result =
                detect(listOf(row(0.0, durationMs, utilization = 0.01, queueLength = 0.0, queueRejections = 1)))

            assertThat(result.degradationPath).describedAs("window $durationMs ms").isEmpty()
        }
    }

    @Test
    fun `sustained queue rejections saturate without a waiting queue`() {
        val result =
            detect(
                listOf(20.0, 70.0, 120.0).map {
                    row(it, durationMs = 50.0, utilization = 0.5, queueLength = 0.0, queueRejections = 1)
                },
            )

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 20.0))
    }

    @Test
    fun `short backlog and isolated overflow do not confirm sustained saturation`() {
        val result =
            detect(
                listOf(
                    row(0.0, durationMs = 50.0),
                    row(50.0, durationMs = 50.0, utilization = 0.5, queueLength = 0.0, queueRejections = 1),
                ),
            )

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `overflow requires evidence separated in time at different window widths`() {
        listOf(10.0, 50.0, 100.0, 200.0).forEach { durationMs ->
            val windows =
                (0..kotlin.math.ceil(100.0 / durationMs).toInt()).map { window ->
                    row(20.0 + window * durationMs, durationMs, utilization = 0.5, queueLength = 0.0, queueRejections = 1)
                }

            assertThat(detect(windows).degradationPath)
                .describedAs("window $durationMs ms")
                .containsExactly(SaturatedNode("service", 20.0))
        }
    }

    @Test
    fun `the last overflow window cannot contribute unobserved persistence`() {
        val result =
            detect(
                listOf(
                    row(0.0, durationMs = 90.0, utilization = 0.5, queueLength = 0.0, queueRejections = 1),
                    row(90.0, utilization = 0.5, queueLength = 0.0, queueRejections = 1),
                ),
            )

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `a missing window breaks the pressure interval`() {
        val result = detect(listOf(0.0, 80.0, 120.0).map { row(it, durationMs = 40.0) })

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `zero duration cannot confirm pressure even with a rejection`() {
        val result = detect(listOf(row(0.0, durationMs = 0.0, queueRejections = 1)))

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `a short final window cannot round the interval up to the minimum duration`() {
        val result = detect(listOf(row(0.0, durationMs = 50.0), row(50.0, durationMs = 49.0)))

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `a short final window contributes its actual duration`() {
        val result =
            detect(
                listOf(
                    row(0.0, durationMs = 50.0),
                    row(50.0, durationMs = 48.0),
                    row(98.0, durationMs = 2.0),
                ),
            )

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 0.0))
    }

    @Test
    fun `fractional window boundaries preserve a continuous hundred milliseconds`() {
        val result = detect((0 until 1000).map { row(it * 0.1, durationMs = 0.1) })

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 0.0))
    }

    @Test
    fun `different window widths locate the same sustained onset within one window`() {
        fun sampled(widthMs: Double): List<NodeWindow> =
            (0 until (500.0 / widthMs).toInt()).map { window ->
                val start = window * widthMs
                row(start, durationMs = widthMs, utilization = if (start >= 123.0) 1.0 else 0.4)
            }

        val fine = detect(sampled(10.0)).degradationPath.single()
        val coarse = detect(sampled(50.0)).degradationPath.single()

        assertThat(fine).isEqualTo(SaturatedNode("service", 130.0))
        assertThat(coarse).isEqualTo(SaturatedNode("service", 150.0))
        assertThat(kotlin.math.abs(fine.startMs - coarse.startMs)).isLessThanOrEqualTo(50.0)
    }

    @Test
    fun `a mostly draining queue does not confirm saturation`() {
        val result = detect(listOf(0.0, 50.0, 100.0).map { row(it, durationMs = 50.0, queueLength = 0.5) })

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `simultaneous onset follows the call chain before node names`() {
        val rows =
            listOf("a-middle", "c-dependency", "b-caller").map { node ->
                row(20.0, durationMs = 100.0).copy(id = node)
            }

        val result =
            SaturationAnalyzer.detect(
                0,
                rows.asSequence(),
                callChain = listOf("b-caller", "a-middle", "c-dependency"),
            )

        assertThat(result.degradationPath)
            .containsExactly(
                SaturatedNode("c-dependency", 20.0),
                SaturatedNode("a-middle", 20.0),
                SaturatedNode("b-caller", 20.0),
            )
    }

    @Test
    fun `an earlier caller precedes a later dependency`() {
        val result =
            SaturationAnalyzer.detect(
                0,
                sequenceOf(
                    row(20.0, durationMs = 100.0).copy(id = "dependency"),
                    row(10.0, durationMs = 100.0).copy(id = "caller"),
                ),
                callChain = listOf("caller", "dependency"),
            )

        assertThat(result.degradationPath)
            .containsExactly(SaturatedNode("caller", 10.0), SaturatedNode("dependency", 20.0))
    }

    @Test
    fun `unrelated simultaneous nodes have a deterministic id fallback`() {
        val rows =
            listOf("z-service", "a-service").map { node ->
                row(0.0, durationMs = 100.0).copy(id = node)
            }

        val result = SaturationAnalyzer.detect(0, rows.asSequence())

        assertThat(result.degradationPath)
            .containsExactly(SaturatedNode("a-service", 0.0), SaturatedNode("z-service", 0.0))
    }

    @Test
    fun `point aggregate keeps first-node timing ties and unsaturated replications separate`() {
        val replications =
            listOf(
                ReplicationSaturation(4, listOf(SaturatedNode("gateway", 15.0))),
                ReplicationSaturation(2, emptyList()),
                ReplicationSaturation(
                    0,
                    listOf(SaturatedNode("dependency", 20.0), SaturatedNode("gateway", 30.0)),
                ),
                ReplicationSaturation(3, listOf(SaturatedNode("gateway", 10.0))),
                ReplicationSaturation(1, listOf(SaturatedNode("dependency", 40.0))),
            )

        val summary = SaturationAnalyzer.aggregate(replications)

        assertThat(summary.rule).isEqualTo(SaturationRule())
        assertThat(summary.withoutSaturation).isEqualTo(1)
        assertThat(summary.replications.map { it.replication }).containsExactly(0, 1, 2, 3, 4)
        assertThat(summary.firstNodes)
            .containsExactly(
                FirstNodeSaturation("dependency", 2, 30.0, 20.0, 40.0),
                FirstNodeSaturation("gateway", 2, 12.5, 10.0, 15.0),
            )
    }

    private fun detect(rows: List<NodeWindow>) = SaturationAnalyzer.detect(0, rows.asSequence())

    private fun hot(startMs: Double) = row(startMs)

    private fun row(
        startMs: Double,
        durationMs: Double = 10.0,
        utilization: Double = 1.0,
        queueLength: Double = 1.0,
        queueRejections: Int = 0,
    ) = NodeWindow(
        "service",
        WindowMetrics(
            startMs = startMs,
            durationMs = durationMs,
            slotPools =
                mapOf(
                    "handlers" to
                        resiliencelab.core.experiment.SlotPoolMetrics(
                            busyIntegralMs = utilization * durationMs,
                            queueIntegralMs =
                                queueLength * durationMs,
                            capacityIntegralMs = (1).toDouble() * (durationMs),
                            queueFullCount = (queueRejections).toLong(),
                        ),
                ),
        ),
    )
}
