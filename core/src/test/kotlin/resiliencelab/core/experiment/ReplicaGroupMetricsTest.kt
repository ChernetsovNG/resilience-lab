package resiliencelab.core.experiment

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.results.NodeWindow
import resiliencelab.core.results.WindowMetrics
import kotlin.test.Test

class ReplicaGroupMetricsTest {
    private val group = ReplicaGroup("worker", ReplicaGroupKind.NODE, (1..12).reversed().map { ReplicaMember("worker#$it", it) })

    @Test
    fun `group sketch pools zero and sparse samples and numeric replica ties use the lower number`() {
        val latencies =
            (1..12).map { replica ->
                LatencyAccumulator(context = "test")
                    .also { accumulator ->
                        if (replica == 2) repeat(100) { accumulator.add(0.0) } else accumulator.add(replica * 10.0)
                    }.snapshot()
            }
        val nodes =
            (1..12).map { replica ->
                NodeWindow(
                    "worker#$replica",
                    WindowMetrics(
                        0.0,
                        10.0,
                        latency = latencies[replica - 1],
                        slotPools =
                            mapOf(
                                "handlers" to
                                    SlotPoolMetrics(
                                        busyIntegralMs = if (replica in listOf(2, 10)) 8.0 else 1.0,
                                        capacityIntegralMs = 10.0,
                                        queueIntegralMs = if (replica in listOf(2, 10)) 20.0 else 0.0,
                                    ),
                            ),
                    ),
                )
            }
        val row = ReplicaGroups.nodeWindows(listOf(group), nodes).single().metrics
        val merged = ReplicaGroups.latency(latencies)
        assertThat(row.latency).isEqualTo(merged)
        assertThat(row.latency.count).isEqualTo(111)
        val pooledP99 = LatencySketch.fromBins(merged.sketch).percentile(0.99)!!
        val meanP99 = latencies.map { LatencySketch.fromBins(it.sketch).percentile(0.99)!! }.average()
        assertThat(pooledP99).isNotEqualTo(meanP99)
        assertThat(row.slotPools.getValue("handlers").replicaExtrema)
            .isEqualTo(ReplicaSlotExtrema(0.1, 0.8, 2, 0.0, 2.0, 2))
    }

    @Test
    fun `whole measurement worst replica pools member integrals and replication summaries use shared time`() {
        val members = ReplicaGroup("worker", ReplicaGroupKind.NODE, listOf(ReplicaMember("worker#2", 2), ReplicaMember("worker#10", 10)))

        fun result(
            first: Double,
            second: Double,
        ): ReplicationResult {
            val rows =
                listOf("worker#2" to first, "worker#10" to second).associate { (id, busy) ->
                    id to
                        ServiceMetrics(
                            1,
                            1,
                            0,
                            0,
                            0,
                            10.0,
                            emptyMap(),
                            latency = LatencyAccumulator(context = "test").also { it.add(busy) }.snapshot(),
                            slotPools =
                                mapOf(
                                    "handlers" to SlotPoolMetrics(busyIntegralMs = busy, capacityIntegralMs = 10.0, queueIntegralMs = busy),
                                ),
                        )
                }
            return ReplicaGroups.replication(
                listOf(members),
                ReplicationResult(
                    allLatency = LatencyStatistics(),
                    successfulLatency = LatencyStatistics(),
                    failedLatency = LatencyStatistics(),
                    originalArrivals = 1,
                    successes = 1,
                    failures = 0,
                    services = rows,
                ),
            )
        }
        val replications = listOf(result(9.0, 4.0), result(0.0, 8.0))
        val aggregate = MetricsAggregator.aggregate(replications).services.getValue("worker")
        assertThat(aggregate.totals.measurementMs).isEqualTo(20.0)
        assertThat(
            aggregate.totals.slotPools
                .getValue("handlers")
                .replicaExtrema!!
                .maxUtilizationReplica,
        ).isEqualTo(10)
        assertThat(
            aggregate.slotPoolSummaries
                .getValue("handlers")
                .meanQueueLength!!
                .mean,
        ).isEqualTo(1.05)
        assertThat(
            aggregate.slotPoolSummaries
                .getValue("handlers")
                .utilization!!
                .count,
        ).isEqualTo(2)
        assertThat(aggregate.meanLatencyMs!!.count).isEqualTo(2)
        assertThat(aggregate.pooledLatency!!.statistics.count).isEqualTo(4)
    }

    @Test
    fun `zero capacity excludes undefined utilization while retaining queue range and numeric ties`() {
        val zero = ReplicaGroups.slots(group, 10.0) { mapOf("handlers" to SlotPoolMetrics(queueIntegralMs = 20.0)) }.getValue("handlers")
        assertThat(zero.replicaExtrema).isEqualTo(ReplicaSlotExtrema(null, null, null, 2.0, 2.0, 1))
    }
}
