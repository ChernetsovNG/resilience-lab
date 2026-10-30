package resiliencelab.core.catalog

/** Transaction-pooler outputs bind window resources and cohort totals without changing their populations. */
internal object PoolerOutputs {
    private fun ratio(
        field: String,
        divisor: String,
    ) = OutputCalculation(OutputCalculationKind.RATIO, field, divisor)

    private fun resource(
        id: String,
        title: String,
        field: String,
        capacity: String,
        order: Int,
    ) = OutputDescriptor(
        id,
        title,
        "Busy connection time divided by available connection time.",
        OutputUnit.PERCENT,
        OutputKind.UTILIZATION,
        OutputCalculation(OutputCalculationKind.NORMALIZED_RATIO, "pooler.$field", "durationMs", "pooler.$capacity"),
        OutputSummary(ratio("totals.$field", "totals.${if (capacity == "poolSize") "server" else "client"}ConnectionCapacityTimeMs")),
        OutputTimeline("poolerResources", "Pooler connections", 3, order),
        OutputInspector(title, order, chartOrder = order),
        OutputOverlay(title, "$title {value}", "Busy connection time / connection capacity time, {interval}.", order),
    )

    private fun count(
        id: String,
        title: String,
        field: String,
        order: Int,
    ) = OutputDescriptor(
        id,
        title,
        "Event count in the window; the summary is the count per independent replication.",
        OutputUnit.REQUESTS,
        OutputKind.COUNT,
        OutputCalculation(OutputCalculationKind.VALUE, field),
        OutputSummary(ratio("totals.${field.substringAfterLast('.')}", "replications"), OutputSummarySource.PER_REPLICATION),
        OutputTimeline("poolerCounts", "Pooler attempts", 0, order),
        OutputInspector(title, order + 3),
    )

    val outputs =
        listOf(
            resource("serverUtilization", "Server pool utilization", "busyServerConnectionTimeMs", "poolSize", 0),
            resource("clientUtilization", "Client connection utilization", "busyClientConnectionTimeMs", "maxClientConnections", 1),
            OutputDescriptor(
                "meanWaitingClients",
                "Waiting clients",
                "Server connection queue integral divided by interval duration.",
                OutputUnit.REQUESTS,
                OutputKind.MEAN_LEVEL,
                ratio("pooler.serverQueueLengthIntegralMs", "durationMs"),
                OutputSummary(ratio("totals.serverQueueLengthIntegralMs", "totals.measurementMs")),
                OutputTimeline("poolerQueue", "Waiting clients", 4, 0),
                OutputInspector("Waiting clients", 2, chartOrder = 2),
                OutputOverlay(
                    "Waiting clients",
                    "Waiting clients {value}",
                    "Server connection queue integral / interval duration, {interval}.",
                    2,
                ),
            ),
            count("offeredAttempts", "Offered attempts", "offeredAttempts", 0),
            count("admittedAttempts", "Admitted attempts", "admittedAttempts", 1),
            count("clientConnectionRejections", "Client connection rejections", "pooler.clientConnectionRejections", 2),
            count("waitTimeouts", "Server wait timeouts", "pooler.waitTimeouts", 3),
            count("successes", "Successful replies", "successes", 4),
            count("failures", "Failed replies", "failures", 5),
            OutputDescriptor(
                "meanServerWaitMs",
                "Mean server connection wait",
                "Completed FIFO waits, including expired waits; immediate acquisitions have no sample.",
                OutputUnit.MILLISECONDS,
                OutputKind.LATENCY,
                ratio("pooler.serverWaitTimeMs", "pooler.serverWaitCount"),
                OutputSummary(ratio("totals.serverWaitTimeMs", "totals.serverWaitCount")),
                OutputTimeline("poolerWait", "Connection wait", 5, 0),
                OutputInspector("Mean server connection wait", 9),
            ),
        ) +
            listOf("mean" to null, "p95" to 0.95, "p99" to 0.99).mapIndexed { index, (name, percentile) ->
                OutputDescriptor(
                    "${name}LatencyMs",
                    if (percentile == null) "Mean residence time" else "$name residence time",
                    "Admitted attempt residence through the reply, including server waiting and wait expiry; client rejections have no sample.",
                    OutputUnit.MILLISECONDS,
                    OutputKind.LATENCY,
                    OutputCalculation(
                        if (percentile ==
                            null
                        ) {
                            OutputCalculationKind.MEAN
                        } else {
                            OutputCalculationKind.QUANTILE
                        },
                        "latency",
                        percentile = percentile,
                    ),
                    if (percentile == null) OutputSummary(OutputCalculation(OutputCalculationKind.VALUE, "pooledLatency.meanMs")) else null,
                    OutputTimeline("latency", "Residence time", 1, index),
                    OutputInspector("Residence time", 10 + index),
                )
            }
}
