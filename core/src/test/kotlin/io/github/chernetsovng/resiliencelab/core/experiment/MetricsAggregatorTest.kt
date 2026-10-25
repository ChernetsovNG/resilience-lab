package io.github.chernetsovng.resiliencelab.core.experiment

import ksl.utilities.statistic.Statistic
import kotlinx.serialization.json.Json
import kotlin.math.sqrt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class MetricsAggregatorTest {
    @Test
    fun `two replications aggregate pooled latency ratios and uncertainty`() {
        val first = replication(
            originalArrivals = 4,
            successes = 3,
            failures = 1,
            allLatencies = listOf(10.0, 20.0, 30.0, 40.0),
            successfulLatencies = listOf(10.0, 20.0, 30.0),
            failedLatencies = listOf(40.0),
            services = mapOf("entry" to service(offered = 6, admitted = 5)),
        )
        val second = replication(
            originalArrivals = 2,
            successes = 1,
            failures = 1,
            allLatencies = listOf(50.0, 60.0),
            successfulLatencies = listOf(50.0),
            failedLatencies = listOf(60.0),
            services = mapOf("entry" to service(offered = 2, admitted = 1)),
        )

        val aggregate = MetricsAggregator.aggregate(listOf(first, second))

        val successRate = assertNotNull(aggregate.successRate)
        assertSummary(successRate, mean = 0.625, stdDev = sqrt(0.03125), min = 0.5, max = 0.75)
        val expectedSuccessInterval = Statistic(doubleArrayOf(0.75, 0.5)).confidenceInterval(0.95)
        assertEquals(expectedSuccessInterval.lowerLimit, assertNotNull(successRate.ci95Low), 1e-12)
        assertEquals(expectedSuccessInterval.upperLimit, assertNotNull(successRate.ci95High), 1e-12)

        val pooledAll = assertNotNull(aggregate.pooledLatency.all)
        assertLatency(pooledAll, meanMs = 35.0, p95Ms = 60.0, p99Ms = 60.0)
        val pooledSuccessful = assertNotNull(aggregate.pooledLatency.successful)
        assertLatency(pooledSuccessful, meanMs = 27.5, p95Ms = 50.0, p99Ms = 50.0)
        val pooledFailed = assertNotNull(aggregate.pooledLatency.failed)
        assertLatency(pooledFailed, meanMs = 50.0, p95Ms = 60.0, p99Ms = 60.0)

        assertSummary(assertNotNull(aggregate.p95LatencyMs), 50.0, sqrt(200.0), 40.0, 60.0)
        assertSummary(assertNotNull(aggregate.p99LatencyMs), 50.0, sqrt(200.0), 40.0, 60.0)

        val service = assertNotNull(aggregate.services["entry"])
        val admitted = assertNotNull(service.admittedAmplification)
        assertSummary(admitted, mean = 0.875, stdDev = sqrt(0.28125), min = 0.5, max = 1.25)
        val offered = assertNotNull(service.offeredAmplification)
        assertSummary(offered, mean = 1.25, stdDev = sqrt(0.125), min = 1.0, max = 1.5)
    }

    @Test
    fun `pooled and across replication percentiles follow KSL interpolation`() {
        val firstLatencies = (1..100).map { it.toDouble() }
        val secondLatencies = (101..200).map { it.toDouble() }
        val first = replication(
            originalArrivals = 100,
            successes = 100,
            failures = 0,
            allLatencies = firstLatencies,
            successfulLatencies = firstLatencies,
            failedLatencies = emptyList(),
            services = emptyMap(),
        )
        val second = replication(
            originalArrivals = 100,
            successes = 100,
            failures = 0,
            allLatencies = secondLatencies,
            successfulLatencies = secondLatencies,
            failedLatencies = emptyList(),
            services = emptyMap(),
        )

        val aggregate = MetricsAggregator.aggregate(listOf(first, second))

        val pooled = assertNotNull(aggregate.pooledLatency.all)
        assertLatency(pooled, meanMs = 100.5, p95Ms = 190.95, p99Ms = 198.99)
        assertSummary(
            assertNotNull(aggregate.p95LatencyMs),
            mean = 145.95,
            stdDev = sqrt(5_000.0),
            min = 95.95,
            max = 195.95,
        )
        assertSummary(
            assertNotNull(aggregate.p99LatencyMs),
            mean = 149.99,
            stdDev = sqrt(5_000.0),
            min = 99.99,
            max = 199.99,
        )
    }

    @Test
    fun `single replication retains point values but has no fabricated uncertainty`() {
        val result = replication(
            originalArrivals = 1,
            successes = 1,
            failures = 0,
            allLatencies = listOf(10.0),
            successfulLatencies = listOf(10.0),
            failedLatencies = emptyList(),
            services = mapOf("entry" to service(offered = 3, admitted = 2)),
        )

        val aggregate = MetricsAggregator.aggregate(listOf(result))

        assertSingleValue(assertNotNull(aggregate.successRate), 1.0)
        assertSingleValue(assertNotNull(aggregate.p95LatencyMs), 10.0)
        assertSingleValue(assertNotNull(aggregate.p99LatencyMs), 10.0)
        assertNull(aggregate.pooledLatency.failed)
        val service = assertNotNull(aggregate.services["entry"])
        assertSingleValue(assertNotNull(service.admittedAmplification), 2.0)
        assertSingleValue(assertNotNull(service.offeredAmplification), 3.0)
    }

    @Test
    fun `empty latency and zero denominator results are serializable nulls`() {
        val result = replication(
            originalArrivals = 0,
            successes = 0,
            failures = 0,
            allLatencies = emptyList(),
            successfulLatencies = emptyList(),
            failedLatencies = emptyList(),
            services = mapOf("entry" to service(offered = 0, admitted = 0)),
        )

        val aggregate = MetricsAggregator.aggregate(listOf(result))

        assertNull(aggregate.successRate)
        assertNull(aggregate.p95LatencyMs)
        assertNull(aggregate.p99LatencyMs)
        assertNull(aggregate.pooledLatency.all)
        assertNull(aggregate.pooledLatency.successful)
        assertNull(aggregate.pooledLatency.failed)
        val service = assertNotNull(aggregate.services["entry"])
        assertNull(service.admittedAmplification)
        assertNull(service.offeredAmplification)

        val encoded = Json.encodeToString(AggregateMetrics.serializer(), aggregate)
        assertFalse(encoded.contains("NaN"))
        assertEquals(aggregate, Json.decodeFromString(AggregateMetrics.serializer(), encoded))
    }

    private fun assertSummary(
        actual: MetricSummary,
        mean: Double,
        stdDev: Double,
        min: Double,
        max: Double,
    ) {
        assertEquals(mean, actual.mean, 1e-9)
        assertEquals(stdDev, assertNotNull(actual.stdDev), 1e-9)
        assertEquals(min, actual.min, 1e-9)
        assertEquals(max, actual.max, 1e-9)
    }

    private fun assertSingleValue(actual: MetricSummary, expected: Double) {
        assertEquals(expected, actual.mean, 1e-12)
        assertEquals(expected, actual.min, 1e-12)
        assertEquals(expected, actual.max, 1e-12)
        assertNull(actual.stdDev)
        assertNull(actual.ci95Low)
        assertNull(actual.ci95High)
    }

    private fun assertLatency(actual: LatencyDistribution, meanMs: Double, p95Ms: Double, p99Ms: Double) {
        assertEquals(meanMs, actual.meanMs, 1e-9)
        assertEquals(p95Ms, actual.p95Ms, 1e-9)
        assertEquals(p99Ms, actual.p99Ms, 1e-9)
    }

    private fun replication(
        originalArrivals: Int,
        successes: Int,
        failures: Int,
        allLatencies: List<Double>,
        successfulLatencies: List<Double>,
        failedLatencies: List<Double>,
        services: Map<String, ServiceMetrics>,
    ): ReplicationResult = ReplicationResult(
        arrivalTimesMs = List(originalArrivals) { it.toDouble() },
        allLatenciesMs = allLatencies,
        successfulLatenciesMs = successfulLatencies,
        failedLatenciesMs = failedLatencies,
        originalArrivals = originalArrivals,
        successes = successes,
        failures = failures,
        services = services,
    )

    private fun service(offered: Int, admitted: Int): ServiceMetrics = ServiceMetrics(
        offeredAttempts = offered,
        admittedAttempts = admitted,
        timeouts = 0,
        retries = 0,
        failures = 0,
        queueRejections = 0,
        handlerUtilization = 0.0,
        meanQueueLength = 0.0,
        p95QueueLength = 0.0,
    )
}
