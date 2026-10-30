package resiliencelab.core.experiment

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class ConnectionAggregationTest {
    @Test
    fun `connection totals pool numerators while uncertainty uses independent replications`() {
        val first = connection(4, 1, 2, 1, 150.0, 20.0, 10.0, 100.0, listOf(10.0, 20.0, 30.0))
        val second = connection(2, 0, 1, 0, 50.0, 30.0, 0.0, 200.0, listOf(100.0))
        val result = MetricsAggregator.aggregate(listOf(replication(first), replication(second))).connections.getValue("call")
        assertThat(result.totals.sentAttempts).isEqualTo(6L)
        assertThat(result.totals.retries).isEqualTo(1L)
        assertThat(result.totals.succeeded).isEqualTo(3L)
        assertThat(result.totals.failed).isEqualTo(1L)
        assertThat(result.totals.timeouts).isEqualTo(2L)
        assertThat(result.totals.orphaned).isEqualTo(2L)
        assertThat(result.totals.inFlightIntegralMs).isEqualTo(200.0)
        assertThat(result.totals.orphanedIntegralMs).isEqualTo(50.0)
        assertThat(result.totals.backoffIntegralMs).isEqualTo(10.0)
        assertThat(result.totals.measurementMs).isEqualTo(300.0)
        assertThat(result.pooledLatency!!.meanMs).isEqualTo(40.0)
        assertThat(result.pooledLatency.statistics.count).isEqualTo(4L)
        assertThat(result.pooledLatency.statistics.sumMs).isEqualTo(160.0)
        assertThat(result.timeoutRate!!.mean).isEqualTo(0.375)
        assertThat(result.timeoutRate.min).isEqualTo(0.25)
        assertThat(result.timeoutRate.max).isEqualTo(0.5)
        assertThat(result.timeoutRate.ci95Low!!).isLessThan(0.0)
        assertThat(result.timeoutRate.ci95High!!).isGreaterThan(1.0)
        assertThat(result.meanInFlight!!.mean).isEqualTo(0.875)
        assertThat(result.meanInFlight.ci95Low).isNotNull()
        assertThat(result.meanInFlight.ci95High).isNotNull()
    }

    @Test
    fun `no responses or attempts produce null distribution and timeout fraction`() {
        val empty = connection(0, 0, 0, 0, 0.0, 0.0, 0.0, 100.0, emptyList(), timeouts = 0)
        val result = MetricsAggregator.aggregate(listOf(replication(empty))).connections.getValue("call")
        assertThat(result.timeoutRate).isNull()
        assertThat(result.pooledLatency).isNull()
        assertThat(result.meanInFlight!!.mean).isZero()
        assertThat(result.meanInFlight.ci95Low).isNull()
        assertThat(result.meanInFlight.ci95High).isNull()
    }

    @Test
    fun `pool totals retain capacity weights and sum waits across replications`() {
        val first =
            connection(0, 0, 0, 0, 0.0, 0.0, 0.0, 100.0, emptyList(), timeouts = 0).copy(
                poolBusyTimeMs = 20.0,
                poolCapacityTimeMs = 100.0,
                poolQueueIntegralMs = 30.0,
                poolWaitCount = 2,
                poolWaitTimeMs = 40.0,
                poolAcquireTimeouts = 1,
            )
        val second = first.copy(poolBusyTimeMs = 50.0, poolCapacityTimeMs = 400.0, poolWaitCount = 3)
        val totals =
            MetricsAggregator
                .aggregate(listOf(replication(first), replication(second)))
                .connections
                .getValue("call")
                .totals
        assertThat(totals.poolBusyTimeMs).isEqualTo(70.0)
        assertThat(totals.poolCapacityTimeMs).isEqualTo(500.0)
        assertThat(totals.poolQueueIntegralMs).isEqualTo(60.0)
        assertThat(totals.poolWaitCount).isEqualTo(5L)
        assertThat(totals.poolWaitTimeMs).isEqualTo(80.0)
        assertThat(totals.poolAcquireTimeouts).isEqualTo(2L)
    }

    private fun connection(
        sent: Int,
        retries: Int,
        succeeded: Int,
        failed: Int,
        inFlight: Double,
        orphaned: Double,
        backoff: Double,
        measurement: Double,
        latencies: List<Double>,
        timeouts: Int = 1,
    ): ConnectionMetrics =
        ConnectionMetrics(
            sent,
            retries,
            succeeded,
            failed,
            timeouts,
            timeouts,
            inFlight,
            orphaned,
            backoff,
            measurement,
            LatencyAccumulator().also { accumulator -> latencies.forEach { accumulator.add(it) } }.snapshot(),
        )

    private fun replication(connection: ConnectionMetrics): ReplicationResult =
        ReplicationResult(
            allLatency = LatencyStatistics(),
            successfulLatency = LatencyStatistics(),
            failedLatency = LatencyStatistics(),
            originalArrivals = 1,
            successes = 0,
            failures = 1,
            services = emptyMap(),
            connections = mapOf("call" to connection),
        )
}
