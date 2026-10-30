package resiliencelab.core.experiment

import ksl.utilities.statistic.Statistic

/**
 * Combines independent replication results without conflating pooled and replication-level statistics.
 * Latency distributions pool observations, while success, percentile, and amplification summaries describe
 * replication-level values; empty distributions and ratios with no original arrivals are omitted.
 */
object MetricsAggregator {
    fun aggregate(replications: List<ReplicationResult>): AggregateMetrics {
        val pooledLatency =
            LatencySummary(
                all = latencyDistribution(replications.map { it.allLatency }),
                successful = latencyDistribution(replications.map { it.successfulLatency }),
                failed = latencyDistribution(replications.map { it.failedLatency }),
            )
        val successRate =
            metricSummary(
                replications.mapNotNull { ratio(it.successes, it.originalArrivals) },
            )
        val p95LatencyMs =
            metricSummary(
                replications.mapNotNull { LatencySketch.fromBins(it.allLatency.sketch).percentile(0.95) },
            )
        val p99LatencyMs =
            metricSummary(
                replications.mapNotNull { LatencySketch.fromBins(it.allLatency.sketch).percentile(0.99) },
            )
        val serviceIds = replications.flatMap { it.services.keys }.distinct()
        val services =
            serviceIds.associateWith { serviceId ->
                AggregateServiceMetrics(
                    admittedAmplification =
                        metricSummary(
                            replications.mapNotNull { replication ->
                                replication.services[serviceId]?.let { service ->
                                    ratio(service.admittedAttempts, replication.originalArrivals)
                                }
                            },
                        ),
                    totals = serviceTotals(replications, serviceId),
                    offeredAmplification =
                        metricSummary(
                            replications.mapNotNull { replication ->
                                replication.services[serviceId]?.let { service ->
                                    ratio(service.offeredAttempts, replication.originalArrivals)
                                }
                            },
                        ),
                )
            }
        return AggregateMetrics(
            pooledLatency = pooledLatency,
            successRate = successRate,
            p95LatencyMs = p95LatencyMs,
            p99LatencyMs = p99LatencyMs,
            services = services,
            connections = connectionMetrics(replications),
            poolers = poolerMetrics(replications),
        )
    }

    private fun connectionMetrics(replications: List<ReplicationResult>): Map<String, AggregateConnectionMetrics> =
        replications.flatMap { it.connections.keys }.distinct().sorted().associateWith { id ->
            val values = replications.mapNotNull { it.connections[id] }
            AggregateConnectionMetrics(
                timeoutRate = metricSummary(values.mapNotNull { ratio(it.timeouts, it.sentAttempts) }),
                meanInFlight = metricSummary(values.map { it.inFlightIntegralMs / it.measurementMs }),
                pooledLatency = latencyDistribution(values.map { it.latency }),
                totals =
                    ConnectionTotals(
                        sentAttempts = values.sumOf { it.sentAttempts.toLong() },
                        retries = values.sumOf { it.retries.toLong() },
                        succeeded = values.sumOf { it.succeeded.toLong() },
                        failed = values.sumOf { it.failed.toLong() },
                        timeouts = values.sumOf { it.timeouts.toLong() },
                        orphaned = values.sumOf { it.orphaned.toLong() },
                        inFlightIntegralMs = values.sumOf { it.inFlightIntegralMs },
                        orphanedIntegralMs = values.sumOf { it.orphanedIntegralMs },
                        backoffIntegralMs = values.sumOf { it.backoffIntegralMs },
                        measurementMs = values.sumOf { it.measurementMs },
                        slotPools = sumSlotPools(values.map { it.slotPools }),
                    ),
            )
        }

    private fun poolerMetrics(replications: List<ReplicationResult>): Map<String, AggregatePoolerMetrics> =
        replications.flatMap { it.poolers.keys }.distinct().sorted().associateWith { id ->
            val values = replications.mapNotNull { it.poolers[id] }
            AggregatePoolerMetrics(
                pooledLatency = latencyDistribution(values.map { it.latency }),
                totals =
                    PoolerTotals(
                        offeredAttempts = values.sumOf { it.offeredAttempts.toLong() },
                        admittedAttempts = values.sumOf { it.admittedAttempts.toLong() },
                        successes = values.sumOf { it.successes.toLong() },
                        failures = values.sumOf { it.failures.toLong() },
                        measurementMs = values.sumOf { it.measurementMs },
                        slotPools = sumSlotPools(values.map { it.slotPools }),
                    ),
            )
        }

    private fun latencyDistribution(values: List<LatencyStatistics>): LatencyDistribution? {
        val accumulator = LatencyAccumulator(context = "pooled latency")
        values.forEach { accumulator.merge(it) }
        val statistics = accumulator.snapshot()
        if (statistics.count == 0L) return null
        val sketch = LatencySketch.fromBins(statistics.sketch)
        return LatencyDistribution(
            meanMs = statistics.sumMs / statistics.count,
            p95Ms = requireNotNull(sketch.percentile(0.95)),
            p99Ms = requireNotNull(sketch.percentile(0.99)),
            statistics = statistics,
        )
    }

    private fun serviceTotals(
        replications: List<ReplicationResult>,
        serviceId: String,
    ): ServiceTotals {
        val services = replications.mapNotNull { it.services[serviceId] }
        return ServiceTotals(
            originalArrivals = replications.filter { serviceId in it.services }.sumOf { it.originalArrivals.toLong() },
            offeredAttempts = services.sumOf { it.offeredAttempts.toLong() },
            admittedAttempts = services.sumOf { it.admittedAttempts.toLong() },
            timeouts = services.sumOf { it.timeouts.toLong() },
            retries = services.sumOf { it.retries.toLong() },
            failures = services.sumOf { it.failures.toLong() },
            measurementMs = services.sumOf { it.measurementMs },
            slotPools = sumSlotPools(services.map { it.slotPools }),
        )
    }

    private fun sumSlotPools(rows: List<Map<String, SlotPoolMetrics>>): Map<String, SlotPoolMetrics> =
        rows.flatMap { it.keys }.distinct().sorted().associateWith { set ->
            val values = rows.mapNotNull { it[set] }
            SlotPoolMetrics(
                values.sumOf { it.busyIntegralMs },
                values.sumOf { it.queueIntegralMs },
                values.sumOf { it.capacityIntegralMs },
                values.sumOf { it.waitCount },
                values.sumOf { it.totalWaitMs },
                values.sumOf { it.queueFullCount },
                values.sumOf { it.waitLimitCount },
            )
        }

    private fun ratio(
        numerator: Int,
        denominator: Int,
    ): Double? {
        if (denominator == 0) return null
        return numerator.toDouble() / denominator.toDouble()
    }

    private fun metricSummary(values: List<Double>): MetricSummary? {
        if (values.isEmpty()) return null
        val statistic = Statistic(values.toDoubleArray())
        val interval = if (values.size >= 2) statistic.confidenceInterval(0.95) else null
        return MetricSummary(
            count = values.size,
            mean = statistic.average,
            stdDev = if (values.size >= 2) statistic.standardDeviation else null,
            ci95Low = interval?.lowerLimit,
            ci95High = interval?.upperLimit,
            min = statistic.min,
            max = statistic.max,
        )
    }
}
