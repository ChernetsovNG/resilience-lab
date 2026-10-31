package resiliencelab.core.results
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.experiment.AggregateEntries
import resiliencelab.core.experiment.AggregateEntryMetrics
import resiliencelab.core.experiment.ConnectionMetrics
import resiliencelab.core.experiment.EntryMetrics
import resiliencelab.core.experiment.LatencyStatistics
import resiliencelab.core.experiment.PoolerMetrics
import resiliencelab.core.experiment.ReplicationEntries
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.experiment.ServiceMetrics
import resiliencelab.core.experiment.SlotPoolMetrics
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Path
import kotlin.test.Test

class CapacityHeadroomTest {
    @Test
    fun `group sums do not compete against instances and ties use ids`() {
        fun service(
            busy: Double,
            queue: Double,
        ) = resiliencelab.core.experiment.AggregateServiceMetrics(
            null,
            null,
            resiliencelab.core.experiment.ServiceTotals(
                0,
                0,
                0,
                0,
                0,
                0,
                100.0,
                mapOf("handlers" to pool(busy, queue)),
            ),
        )
        val aggregate =
            resiliencelab.core.experiment.AggregateMetrics(
                entries =
                    AggregateEntries(
                        AggregateEntryMetrics(resiliencelab.core.experiment.LatencySummary(null, null, null), null, null, null),
                        emptyMap(),
                        emptyMap(),
                    ),
                services =
                    linkedMapOf(
                        "workers#2" to service(90.0, 60.0),
                        "workers" to service(180.0, 120.0),
                        "workers#1" to service(90.0, 60.0),
                    ),
                groups =
                    listOf(
                        resiliencelab.core.experiment.ReplicaGroup(
                            "workers",
                            resiliencelab.core.experiment.ReplicaGroupKind.NODE,
                            listOf(
                                resiliencelab.core.experiment.ReplicaMember("workers#1", 1),
                                resiliencelab.core.experiment.ReplicaMember("workers#2", 2),
                            ),
                        ),
                    ),
            )
        val result = CapacityHeadroomAnalyzer.analyze(aggregate)
        assertThat(result.utilization?.node).isEqualTo("workers#1")
        assertThat(result.utilization?.value).isEqualTo(0.9)
        assertThat(result.meanQueueLength?.node).isEqualTo("workers#1")
        assertThat(result.meanQueueLength?.value).isEqualTo(0.6)
    }

    @Test
    fun `zero denominators have no invented headroom value`() {
        val service =
            resiliencelab.core.experiment.AggregateServiceMetrics(
                null,
                null,
                resiliencelab.core.experiment.ServiceTotals(
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0.0,
                    mapOf("handlers" to SlotPoolMetrics()),
                ),
            )
        val aggregate =
            resiliencelab.core.experiment.AggregateMetrics(
                entries =
                    AggregateEntries(
                        AggregateEntryMetrics(resiliencelab.core.experiment.LatencySummary(null, null, null), null, null, null),
                        emptyMap(),
                        emptyMap(),
                    ),
                services =
                    mapOf(
                        "service" to service,
                    ),
            )
        assertThat(CapacityHeadroomAnalyzer.analyze(aggregate)).isEqualTo(CapacityHeadroom())
    }

    @Test
    fun `core records independent maxima across service connection and pooler slots`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = ArtifactWriter(workspace)
        val directory = ".results/e/r"
        writer.writeReplication(
            "$directory/series/v/p0/rep-0",
            ReplicationResult(
                entries =
                    ReplicationEntries(
                        EntryMetrics(
                            allLatency = LatencyStatistics(),
                            successfulLatency = LatencyStatistics(),
                            failedLatency = LatencyStatistics(),
                            originalArrivals = 0,
                            successes = 0,
                            failures = 0,
                        ),
                        emptyMap(),
                        emptyMap(),
                    ),
                services =
                    mapOf(
                        "gateway" to
                            ServiceMetrics(
                                0,
                                0,
                                0,
                                0,
                                0,
                                100.0,
                                emptyMap(),
                                slotPools = mapOf("handlers" to pool(50.0, 20.0)),
                            ),
                    ),
                connections =
                    mapOf(
                        "to-pooler" to
                            ConnectionMetrics(
                                0,
                                0,
                                0,
                                0,
                                0,
                                0,
                                0.0,
                                0.0,
                                0.0,
                                100.0,
                                LatencyStatistics(),
                                slotPools = mapOf("pool" to pool(90.0, 80.0)),
                            ),
                    ),
                poolers =
                    mapOf(
                        "pooler" to
                            PoolerMetrics(
                                0,
                                0,
                                0,
                                0,
                                100.0,
                                LatencyStatistics(),
                                slotPools = mapOf("serverConnections" to pool(70.0, 100.0)),
                            ),
                    ),
            ),
        )
        val series = SeriesWriter(workspace, "$directory/series/v/p0/rep-0", 100.0, 100.0)
        series.writeWindow(0, listOf(NodeWindow("client", WindowMetrics(0.0, 100.0))))
        series.finish()
        val result =
            writer.summarize(
                directory,
                "e",
                listOf("v" to "V"),
                1,
                listOf(GridPoint("p0", emptyMap())),
                emptyList(),
                emptyList(),
            )
        val point =
            result.variants
                .single()
                .points
                .single()
        val encoded = Json.encodeToJsonElement(PointSummary.serializer(), point).jsonObject
        assertThat(encoded.keys).contains("headroom")
        val headroom = encoded.getValue("headroom").jsonObject
        val utilization = headroom.getValue("utilization").jsonObject
        val queue = headroom.getValue("meanQueueLength").jsonObject
        assertThat(utilization.getValue("node").jsonPrimitive.content).isEqualTo("to-pooler")
        assertThat(utilization.getValue("slotPool").jsonPrimitive.content).isEqualTo("pool")
        assertThat(utilization.getValue("value").jsonPrimitive.double).isEqualTo(0.9)
        assertThat(queue.getValue("node").jsonPrimitive.content).isEqualTo("pooler")
        assertThat(queue.getValue("slotPool").jsonPrimitive.content).isEqualTo("serverConnections")
        assertThat(queue.getValue("value").jsonPrimitive.double).isEqualTo(1.0)
    }

    private fun pool(
        busy: Double,
        queue: Double,
    ) = SlotPoolMetrics(
        busyIntegralMs = busy,
        capacityIntegralMs = 100.0,
        queueIntegralMs = queue,
    )
}
