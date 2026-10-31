package resiliencelab.core.experiment

import kotlinx.serialization.json.Json
import ksl.utilities.statistic.Statistic
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import kotlin.math.sqrt
import kotlin.test.Test

class MetricsAggregatorTest {
    @Test
    fun `two replications aggregate pooled latency ratios and uncertainty`() {
        val first =
            replication(
                originalArrivals = 4,
                successes = 3,
                failures = 1,
                allLatencies = listOf(10.0, 20.0, 30.0, 40.0),
                successfulLatencies = listOf(10.0, 20.0, 30.0),
                failedLatencies = listOf(40.0),
                services = mapOf("entry" to service(offered = 6, admitted = 5)),
            )
        val second =
            replication(
                originalArrivals = 2,
                successes = 1,
                failures = 1,
                allLatencies = listOf(50.0, 60.0),
                successfulLatencies = listOf(50.0),
                failedLatencies = listOf(60.0),
                services = mapOf("entry" to service(offered = 2, admitted = 1)),
            )

        val aggregate = MetricsAggregator.aggregate(listOf(first, second))

        val successRate = aggregate.entries.total.successRate
        assertThat(successRate).isNotNull()
        assertSummary(successRate!!, mean = 0.625, stdDev = sqrt(0.03125), min = 0.5, max = 0.75)
        val expectedSuccessInterval = Statistic(doubleArrayOf(0.75, 0.5)).confidenceInterval(0.95)
        assertThat(successRate.ci95Low).isNotNull()
        assertThat(successRate.ci95Low!!).isCloseTo(expectedSuccessInterval.lowerLimit, offset(1e-12))
        assertThat(successRate.ci95High).isNotNull()
        assertThat(successRate.ci95High!!).isCloseTo(expectedSuccessInterval.upperLimit, offset(1e-12))

        val pooledAll = aggregate.entries.total.pooledLatency.all
        assertThat(pooledAll).isNotNull()
        assertLatency(pooledAll!!, meanMs = 35.0, p95Ms = 60.0, p99Ms = 60.0)
        val pooledSuccessful = aggregate.entries.total.pooledLatency.successful
        assertThat(pooledSuccessful).isNotNull()
        assertLatency(pooledSuccessful!!, meanMs = 27.5, p95Ms = 50.0, p99Ms = 50.0)
        val pooledFailed = aggregate.entries.total.pooledLatency.failed
        assertThat(pooledFailed).isNotNull()
        assertLatency(pooledFailed!!, meanMs = 50.0, p95Ms = 60.0, p99Ms = 60.0)

        assertThat(aggregate.entries.total.p95LatencyMs).isNotNull()
        assertQuantileSummary(aggregate.entries.total.p95LatencyMs!!, listOf(listOf(10.0, 20.0, 30.0, 40.0), listOf(50.0, 60.0)), 0.95)
        assertThat(aggregate.entries.total.p99LatencyMs).isNotNull()
        assertQuantileSummary(aggregate.entries.total.p99LatencyMs!!, listOf(listOf(10.0, 20.0, 30.0, 40.0), listOf(50.0, 60.0)), 0.99)

        val service = aggregate.services["entry"]
        assertThat(service).isNotNull()
        val admitted = service!!.admittedAmplification
        assertThat(admitted).isNotNull()
        assertSummary(admitted!!, mean = 0.875, stdDev = sqrt(0.28125), min = 0.5, max = 1.25)
        val offered = service.offeredAmplification
        assertThat(offered).isNotNull()
        assertSummary(offered!!, mean = 1.25, stdDev = sqrt(0.125), min = 1.0, max = 1.5)
    }

    @Test
    fun `pooled and across replication percentiles follow KSL interpolation`() {
        val firstLatencies = (1..100).map { it.toDouble() }
        val secondLatencies = (101..200).map { it.toDouble() }
        val first =
            replication(
                originalArrivals = 100,
                successes = 100,
                failures = 0,
                allLatencies = firstLatencies,
                successfulLatencies = firstLatencies,
                failedLatencies = emptyList(),
                services = emptyMap(),
            )
        val second =
            replication(
                originalArrivals = 100,
                successes = 100,
                failures = 0,
                allLatencies = secondLatencies,
                successfulLatencies = secondLatencies,
                failedLatencies = emptyList(),
                services = emptyMap(),
            )

        val aggregate = MetricsAggregator.aggregate(listOf(first, second))

        val pooled = aggregate.entries.total.pooledLatency.all
        assertThat(pooled).isNotNull()
        assertLatency(pooled!!, meanMs = 100.5, p95Ms = 190.95, p99Ms = 198.99)
        assertThat(aggregate.entries.total.p95LatencyMs).isNotNull()
        assertQuantileSummary(aggregate.entries.total.p95LatencyMs!!, listOf(firstLatencies, secondLatencies), 0.95)
        assertThat(aggregate.entries.total.p99LatencyMs).isNotNull()
        assertQuantileSummary(aggregate.entries.total.p99LatencyMs!!, listOf(firstLatencies, secondLatencies), 0.99)
    }

    @Test
    fun `single replication retains point values but has no fabricated uncertainty`() {
        val result =
            replication(
                originalArrivals = 1,
                successes = 1,
                failures = 0,
                allLatencies = listOf(10.0),
                successfulLatencies = listOf(10.0),
                failedLatencies = emptyList(),
                services = mapOf("entry" to service(offered = 3, admitted = 2)),
            )

        val aggregate = MetricsAggregator.aggregate(listOf(result))

        assertThat(aggregate.entries.total.successRate).isNotNull()
        assertSingleValue(aggregate.entries.total.successRate!!, 1.0)
        assertThat(aggregate.entries.total.p95LatencyMs).isNotNull()
        assertSingleValue(aggregate.entries.total.p95LatencyMs!!, sketchPercentile(listOf(10.0), 0.95))
        assertThat(aggregate.entries.total.p99LatencyMs).isNotNull()
        assertSingleValue(aggregate.entries.total.p99LatencyMs!!, sketchPercentile(listOf(10.0), 0.99))
        assertThat(aggregate.entries.total.pooledLatency.failed).isNull()
        val service = aggregate.services["entry"]
        assertThat(service).isNotNull()
        assertThat(service!!.admittedAmplification).isNotNull()
        assertSingleValue(service.admittedAmplification!!, 2.0)
        assertThat(service.offeredAmplification).isNotNull()
        assertSingleValue(service.offeredAmplification!!, 3.0)
    }

    @Test
    fun `empty latency and zero denominator results are serializable nulls`() {
        val result =
            replication(
                originalArrivals = 0,
                successes = 0,
                failures = 0,
                allLatencies = emptyList(),
                successfulLatencies = emptyList(),
                failedLatencies = emptyList(),
                services = mapOf("entry" to service(offered = 0, admitted = 0)),
            )

        val aggregate = MetricsAggregator.aggregate(listOf(result))

        assertThat(aggregate.entries.total.successRate).isNull()
        assertThat(aggregate.entries.total.p95LatencyMs).isNull()
        assertThat(aggregate.entries.total.p99LatencyMs).isNull()
        assertThat(aggregate.entries.total.pooledLatency.all).isNull()
        assertThat(aggregate.entries.total.pooledLatency.successful).isNull()
        assertThat(aggregate.entries.total.pooledLatency.failed).isNull()
        val service = aggregate.services["entry"]
        assertThat(service).isNotNull()
        assertThat(service!!.admittedAmplification).isNull()
        assertThat(service.offeredAmplification).isNull()

        val encoded = Json.encodeToString(AggregateMetrics.serializer(), aggregate)
        assertThat(encoded).doesNotContain("NaN")
        assertThat(Json.decodeFromString(AggregateMetrics.serializer(), encoded)).isEqualTo(aggregate)
    }

    private fun sketchPercentile(
        values: List<Double>,
        p: Double,
    ): Double = LatencySketch().apply { values.forEach { add(it) } }.percentile(p)!!

    private fun assertQuantileSummary(
        actual: MetricSummary,
        values: List<List<Double>>,
        p: Double,
    ) {
        val statistic = Statistic(values.map { sketchPercentile(it, p) }.toDoubleArray())
        assertSummary(actual, statistic.average, statistic.standardDeviation, statistic.min, statistic.max)
        val interval = statistic.confidenceInterval(0.95)
        assertThat(actual.ci95Low!!).isCloseTo(interval.lowerLimit, offset(1e-9))
        assertThat(actual.ci95High!!).isCloseTo(interval.upperLimit, offset(1e-9))
    }

    private fun assertSummary(
        actual: MetricSummary,
        mean: Double,
        stdDev: Double,
        min: Double,
        max: Double,
    ) {
        assertThat(actual.mean).isCloseTo(mean, offset(1e-9))
        assertThat(actual.stdDev).isNotNull()
        assertThat(actual.stdDev!!).isCloseTo(stdDev, offset(1e-9))
        assertThat(actual.min).isCloseTo(min, offset(1e-9))
        assertThat(actual.max).isCloseTo(max, offset(1e-9))
    }

    private fun assertSingleValue(
        actual: MetricSummary,
        expected: Double,
    ) {
        assertThat(actual.mean).isCloseTo(expected, offset(1e-12))
        assertThat(actual.min).isCloseTo(expected, offset(1e-12))
        assertThat(actual.max).isCloseTo(expected, offset(1e-12))
        assertThat(actual.stdDev).isNull()
        assertThat(actual.ci95Low).isNull()
        assertThat(actual.ci95High).isNull()
    }

    private fun assertLatency(
        actual: LatencyDistribution,
        meanMs: Double,
        p95Ms: Double,
        p99Ms: Double,
    ) {
        assertThat(actual.meanMs).isCloseTo(meanMs, offset(1e-9))
        assertThat(actual.p95Ms).isCloseTo(p95Ms, offset(p95Ms / 128 + 1e-9))
        assertThat(actual.p99Ms).isCloseTo(p99Ms, offset(p99Ms / 128 + 1e-9))
    }

    private fun replication(
        originalArrivals: Int,
        successes: Int,
        failures: Int,
        allLatencies: List<Double>,
        successfulLatencies: List<Double>,
        failedLatencies: List<Double>,
        services: Map<String, ServiceMetrics>,
    ): ReplicationResult =
        ReplicationResult(
            entries =
                ReplicationEntries(
                    EntryMetrics(
                        allLatency = latencyStatistics(allLatencies),
                        successfulLatency = latencyStatistics(successfulLatencies),
                        failedLatency = latencyStatistics(failedLatencies),
                        originalArrivals = originalArrivals,
                        successes = successes,
                        failures = failures,
                    ),
                    emptyMap(),
                    emptyMap(),
                ),
            arrivalTimesMs =
                List(originalArrivals) {
                    it.toDouble()
                },
            services = services,
        )

    private fun service(
        offered: Int,
        admitted: Int,
    ): ServiceMetrics =
        ServiceMetrics(
            offeredAttempts = offered,
            admittedAttempts = admitted,
            timeouts = 0,
            retries = 0,
            failures = 0,
            measurementMs = 1.0,
            queueDurationsMs = emptyMap(),
            slotPools =
                mapOf(
                    "handlers" to
                        resiliencelab.core.experiment.SlotPoolMetrics(
                            busyIntegralMs = 0.0,
                            queueIntegralMs = 0.0,
                            capacityIntegralMs =
                                (1).toDouble() * (1.0),
                            queueFullCount = (0).toLong(),
                        ),
                ),
        )
}
