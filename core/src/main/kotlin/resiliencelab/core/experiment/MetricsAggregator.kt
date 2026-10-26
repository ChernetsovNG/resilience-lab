package resiliencelab.core.experiment

import ksl.utilities.statistic.Statistic

object MetricsAggregator {
    fun aggregate(replications: List<ReplicationResult>): AggregateMetrics {
        val pooledLatency = LatencySummary(
            all = latencyDistribution(replications.flatMap { it.allLatenciesMs }),
            successful = latencyDistribution(replications.flatMap { it.successfulLatenciesMs }),
            failed = latencyDistribution(replications.flatMap { it.failedLatenciesMs }),
        )
        val successRate = metricSummary(
            replications.mapNotNull { ratio(it.successes, it.originalArrivals) },
        )
        val p95LatencyMs = metricSummary(
            replications.mapNotNull { percentile(it.allLatenciesMs, 0.95) },
        )
        val p99LatencyMs = metricSummary(
            replications.mapNotNull { percentile(it.allLatenciesMs, 0.99) },
        )
        val serviceIds = replications.flatMap { it.services.keys }.distinct()
        val services = serviceIds.associateWith { serviceId ->
            AggregateServiceMetrics(
                admittedAmplification = metricSummary(
                    replications.mapNotNull { replication ->
                        replication.services[serviceId]?.let { service ->
                            ratio(service.admittedAttempts, replication.originalArrivals)
                        }
                    },
                ),
                offeredAmplification = metricSummary(
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
        )
    }

    private fun latencyDistribution(valuesMs: List<Double>): LatencyDistribution? {
        if (valuesMs.isEmpty()) return null
        return LatencyDistribution(
            meanMs = Statistic(valuesMs.toDoubleArray()).average,
            p95Ms = Statistic.percentile(valuesMs.toDoubleArray(), 0.95),
            p99Ms = Statistic.percentile(valuesMs.toDoubleArray(), 0.99),
        )
    }

    private fun percentile(valuesMs: List<Double>, probability: Double): Double? {
        if (valuesMs.isEmpty()) return null
        return Statistic.percentile(valuesMs.toDoubleArray(), probability)
    }

    private fun ratio(numerator: Int, denominator: Int): Double? {
        if (denominator == 0) return null
        return numerator.toDouble() / denominator.toDouble()
    }

    private fun metricSummary(values: List<Double>): MetricSummary? {
        if (values.isEmpty()) return null
        val statistic = Statistic(values.toDoubleArray())
        val interval = if (values.size >= 2) statistic.confidenceInterval(0.95) else null
        return MetricSummary(
            mean = statistic.average,
            stdDev = if (values.size >= 2) statistic.standardDeviation else null,
            ci95Low = interval?.lowerLimit,
            ci95High = interval?.upperLimit,
            min = statistic.min,
            max = statistic.max,
        )
    }
}
