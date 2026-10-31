package resiliencelab.core.experiment

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.document.DocumentCodec
import kotlin.test.Test

class EntryMetricsTest {
    @Test
    fun `entry reason rates include zero contributions and use each population denominator`() {
        val mobileFirst = entry(2, 1, mapOf("timeout" to 1))
        val partnerFirst = entry(1, 1)
        val first =
            ReplicationResult(
                entries =
                    ReplicationEntries(
                        entry(3, 2, mapOf("timeout" to 1)),
                        mapOf("mobile" to mobileFirst, "partner" to partnerFirst),
                        mapOf("status" to entry(3, 2, mapOf("timeout" to 1)), "unused" to entry(0, 0)),
                    ),
                services = emptyMap(),
            )
        val second =
            ReplicationResult(
                entries =
                    ReplicationEntries(
                        entry(4, 4),
                        mapOf("mobile" to entry(4, 4), "partner" to entry(0, 0)),
                        mapOf("status" to entry(4, 4), "unused" to entry(0, 0)),
                    ),
                services = emptyMap(),
            )
        val result = MetricsAggregator.aggregate(listOf(first, second)).entries
        assertThat(
            result.total.failuresByReason
                .getValue("timeout")
                .count,
        ).isEqualTo(2)
        assertThat(
            result.total.failuresByReason
                .getValue("timeout")
                .mean,
        ).isCloseTo(1.0 / 6, offset(1e-15))
        assertThat(
            result.clients
                .getValue("mobile")
                .failuresByReason
                .getValue("timeout")
                .mean,
        ).isEqualTo(0.25)
        assertThat(
            result.clients
                .getValue("partner")
                .successRate!!
                .count,
        ).isEqualTo(1)
        assertThat(result.clients.getValue("partner").failuresByReason).isEmpty()
        assertThat(result.classes.getValue("status")).isEqualTo(result.total)
        assertThat(result.classes.getValue("unused").successRate).isNull()
        assertThat(result.classes.getValue("unused").degradedRate).isNull()
        assertThat(result.total.degradedRate!!.mean).isZero()
        assertThat(
            result.total.pooledLatency.all!!
                .statistics.count,
        ).isEqualTo(7)
    }

    @Test
    fun `replica groups and pooled totals merge causes without changing legacy local failure counts`() {
        val group = ReplicaGroup("workers", ReplicaGroupKind.NODE, listOf(ReplicaMember("workers#1", 1), ReplicaMember("workers#2", 2)))
        val calls = ReplicaGroup("call", ReplicaGroupKind.CONNECTION, listOf(ReplicaMember("call#1", 1), ReplicaMember("call#2", 2)))
        val original =
            ReplicationResult(
                entries = ReplicationEntries(entry(2, 0, mapOf("queueFull" to 2)), emptyMap(), emptyMap()),
                services =
                    mapOf(
                        "workers#1" to service(mapOf("queueFull" to 2)),
                        "workers#2" to service(mapOf("error" to 1, "queueFull" to 1)),
                    ),
                connections =
                    mapOf(
                        "call#1" to connection(mapOf("timeout" to 2)),
                        "call#2" to connection(mapOf("timeout" to 1, "waitLimit" to 1)),
                    ),
            )
        val grouped = ReplicaGroups.replication(listOf(group, calls), original)
        assertThat(grouped.services.getValue("workers").failuresByReason).containsExactlyEntriesOf(mapOf("error" to 1, "queueFull" to 3))
        assertThat(grouped.services.getValue("workers").failures).isZero()
        assertThat(grouped.connections.getValue("call").failuresByReason).containsExactlyEntriesOf(mapOf("timeout" to 3, "waitLimit" to 1))
        val aggregate = MetricsAggregator.aggregate(listOf(grouped, grouped))
        assertThat(
            aggregate.services
                .getValue("workers")
                .totals.failuresByReason,
        ).containsExactlyEntriesOf(
            mapOf(
                "error" to 2L,
                "queueFull" to 6L,
            ),
        )
        assertThat(
            aggregate.services
                .getValue("workers")
                .totals.failures,
        ).isZero()
        assertThat(
            aggregate.connections
                .getValue("call")
                .totals.failuresByReason,
        ).containsExactlyEntriesOf(
            mapOf(
                "timeout" to 6L,
                "waitLimit" to 2L,
            ),
        )
    }

    @Test
    fun `group windows use all clients and exclude request class rows from the shared denominator`() {
        val group = ReplicaGroup("workers", ReplicaGroupKind.NODE, listOf(ReplicaMember("workers#1", 1), ReplicaMember("workers#2", 2)))
        val clients = listOf("mobile", "partner")
        val nodes =
            listOf(
                resiliencelab.core.results.NodeWindow("mobile", resiliencelab.core.results.WindowMetrics(0.0, 10.0, originalArrivals = 2)),
                resiliencelab.core.results.NodeWindow("partner", resiliencelab.core.results.WindowMetrics(0.0, 10.0, originalArrivals = 3)),
                resiliencelab.core.results.NodeWindow(
                    "mobile",
                    resiliencelab.core.results.WindowMetrics(0.0, 10.0, originalArrivals = 5),
                    isClass = true,
                ),
                resiliencelab.core.results.NodeWindow(
                    "workers#1",
                    resiliencelab.core.results.WindowMetrics(
                        0.0,
                        10.0,
                        failuresByReason =
                            mapOf(
                                "queueFull" to 2,
                            ),
                    ),
                ),
                resiliencelab.core.results.NodeWindow(
                    "workers#2",
                    resiliencelab.core.results.WindowMetrics(
                        0.0,
                        10.0,
                        failuresByReason =
                            mapOf(
                                "queueFull" to 1,
                            ),
                    ),
                ),
            )
        val window = ReplicaGroups.nodeWindows(listOf(group), nodes, clientIds = clients).single().metrics
        assertThat(window.clientOriginalArrivals).isEqualTo(5)
        assertThat(window.failuresByReason).containsExactlyEntriesOf(mapOf("queueFull" to 3))
    }

    @Test
    fun `empty entry serializes all cohort fields for a source with no arrivals`() {
        val encoded = Json.parseToJsonElement(DocumentCodec.encode(EntryMetrics.serializer(), EntryMetrics())).jsonObject
        assertThat(encoded.keys).containsExactlyInAnyOrder(
            "allLatency",
            "successfulLatency",
            "failedLatency",
            "originalArrivals",
            "successes",
            "failures",
            "degraded",
            "failuresByReason",
        )
        assertThat(encoded.getValue("failedLatency").jsonObject).containsKey("count")
    }

    private fun entry(
        arrivals: Int,
        successes: Int,
        reasons: Map<String, Int> = emptyMap(),
    ): EntryMetrics {
        val successful = LatencyAccumulator().apply { repeat(successes) { add(5.0) } }.snapshot()
        val failed = LatencyAccumulator().apply { repeat(arrivals - successes) { add(10.0) } }.snapshot()
        return EntryMetrics(
            allLatency = ReplicaGroups.latency(listOf(successful, failed)),
            successfulLatency = successful,
            failedLatency = failed,
            originalArrivals = arrivals,
            successes = successes,
            failures = arrivals - successes,
            failuresByReason = reasons,
        )
    }

    private fun service(reasons: Map<String, Int>) = ServiceMetrics(0, 0, 0, 0, 0, 100.0, emptyMap(), failuresByReason = reasons)

    private fun connection(reasons: Map<String, Int>) =
        ConnectionMetrics(0, 0, 0, 0, 0, 0, 0.0, 0.0, 0.0, 100.0, LatencyStatistics(), failuresByReason = reasons)
}
