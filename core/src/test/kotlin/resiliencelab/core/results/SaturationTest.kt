package resiliencelab.core.results

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class SaturationTest {
    @Test
    fun `three consecutive hot windows saturate at the first window`() {
        val result = detect(listOf(hot(0.0), hot(10.0), hot(20.0)))

        assertThat(result).isEqualTo(ReplicationSaturation(0, listOf(SaturatedNode("service", 0.0))))
    }

    @Test
    fun `a cold window breaks the hot streak`() {
        val result =
            detect(
                listOf(
                    hot(0.0),
                    hot(10.0),
                    cold(20.0),
                    hot(30.0),
                    hot(40.0),
                    hot(50.0),
                ),
            )

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 30.0))
    }

    @Test
    fun `queue rejection saturates before three hot windows`() {
        val result = detect(listOf(hot(0.0), hot(10.0), cold(20.0, queueRejections = 1)))

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 20.0))
    }

    @Test
    fun `rejection in the third hot window keeps the earlier streak start`() {
        val result = detect(listOf(hot(0.0), hot(10.0), hot(20.0, queueRejections = 1)))

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 0.0))
    }

    @Test
    fun `simultaneous saturation sorts nodes by id`() {
        val rows =
            listOf(0.0, 10.0, 20.0).map { start ->
                listOf(
                    NodeWindow("z-service", hotMetrics(start)),
                    NodeWindow("a-service", hotMetrics(start)),
                )
            }

        val result = SaturationAnalyzer.detect(0, rows.asSequence().flatMap { it.asSequence() })

        assertThat(result.degradationPath)
            .containsExactly(SaturatedNode("a-service", 0.0), SaturatedNode("z-service", 0.0))
    }

    @Test
    fun `no saturation gives an explicitly empty path`() {
        val result = detect(listOf(hot(0.0), hot(10.0), cold(20.0)))

        assertThat(result.degradationPath).isEmpty()
    }

    @Test
    fun `short final window uses its actual duration`() {
        val result =
            detect(
                listOf(
                    hot(0.0),
                    hot(10.0),
                    NodeWindow("service", hotMetrics(20.0, durationMs = 2.0, busyMs = 1.9, queueIntegralMs = 1.0)),
                ),
            )

        assertThat(result.degradationPath).containsExactly(SaturatedNode("service", 0.0))
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

        assertThat(summary.rule).isEqualTo(SaturationRule(3, 0.95, 0.0))
        assertThat(summary.withoutSaturation).isEqualTo(1)
        assertThat(summary.replications.map { it.replication }).containsExactly(0, 1, 2, 3, 4)
        assertThat(summary.firstNodes)
            .containsExactly(
                FirstNodeSaturation("dependency", 2, 30.0, 20.0, 40.0),
                FirstNodeSaturation("gateway", 2, 12.5, 10.0, 15.0),
            )
    }

    private fun detect(rows: List<NodeWindow>) = SaturationAnalyzer.detect(0, rows.asSequence())

    private fun hot(
        startMs: Double,
        queueRejections: Int = 0,
    ) = NodeWindow("service", hotMetrics(startMs, queueRejections = queueRejections))

    private fun cold(
        startMs: Double,
        queueRejections: Int = 0,
    ) = NodeWindow(
        "service",
        WindowMetrics(
            startMs = startMs,
            durationMs = 10.0,
            busyHandlerTimeMs = 9.4,
            handlers = 1,
            queueLengthIntegralMs = 10.0,
            queueRejections = queueRejections,
        ),
    )

    private fun hotMetrics(
        startMs: Double,
        durationMs: Double = 10.0,
        busyMs: Double = 9.5,
        queueIntegralMs: Double = 10.0,
        queueRejections: Int = 0,
    ) = WindowMetrics(
        startMs = startMs,
        durationMs = durationMs,
        busyHandlerTimeMs = busyMs,
        handlers = 1,
        queueLengthIntegralMs = queueIntegralMs,
        queueRejections = queueRejections,
    )
}
