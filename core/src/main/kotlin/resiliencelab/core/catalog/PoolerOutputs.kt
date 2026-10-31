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
        label: String,
        set: String,
        order: Int,
    ) = SlotPoolOutputs.output(
        set,
        SlotPoolOutputs.Quantity.UTILIZATION,
        id,
        title,
        "Busy connection time divided by available connection time.",
        OutputTimeline("poolerResources", "Pooler connections", 3, order),
        OutputInspector(title, order, chartOrder = order),
        OutputOverlay(title, "$label {value}", "Busy connection time / connection capacity time, {interval}.", order),
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
            resource("serverUtilization", "Server pool utilization", "Server pool", "serverConnections", 0),
            resource("clientUtilization", "Client connection utilization", "Clients", "clientConnections", 1),
            SlotPoolOutputs.output(
                "serverConnections",
                SlotPoolOutputs.Quantity.QUEUE,
                "meanWaitingClients",
                "Waiting clients",
                "Server connection queue integral divided by interval duration.",
                OutputTimeline("poolerQueue", "Waiting clients", 4, 0),
                OutputInspector("Waiting clients", 2, chartOrder = 2),
                OutputOverlay(
                    "Waiting clients",
                    "Waiting {value}",
                    "Server connection queue integral / interval duration, {interval}.",
                    2,
                ),
            ),
            count("offeredAttempts", "Offered attempts", "offeredAttempts", 0),
            count("admittedAttempts", "Admitted attempts", "admittedAttempts", 1),
            SlotPoolOutputs.output(
                "clientConnections",
                SlotPoolOutputs.Quantity.QUEUE_FULL,
                "clientConnectionRejections",
                "Client connection rejections",
                "Event count in the window; the summary is the count per independent replication.",
                OutputTimeline("poolerCounts", "Pooler attempts", 0, 2),
                OutputInspector("Client connection rejections", 5),
            ),
            SlotPoolOutputs.output(
                "serverConnections",
                SlotPoolOutputs.Quantity.WAIT_LIMIT,
                "waitTimeouts",
                "Server wait timeouts",
                "Event count in the window; the summary is the count per independent replication.",
                OutputTimeline("poolerCounts", "Pooler attempts", 0, 3),
                OutputInspector("Server wait timeouts", 6),
            ),
            count("successes", "Successful replies", "successes", 4),
            count("failures", "Failed replies", "failures", 5),
            SlotPoolOutputs.output(
                "serverConnections",
                SlotPoolOutputs.Quantity.WAIT,
                "meanServerWaitMs",
                "Mean server connection wait",
                "Completed FIFO waits, including expired waits; immediate acquisitions have no sample.",
                OutputTimeline("poolerWait", "Connection wait", 5, 0),
                OutputInspector("Mean server connection wait", 9),
            ),
            SlotPoolOutputs.output(
                "clientConnections",
                SlotPoolOutputs.Quantity.QUEUE,
                "meanClientQueue",
                "Mean client queue",
                "Client connection queue integral / duration.",
            ),
            SlotPoolOutputs.output(
                "clientConnections",
                SlotPoolOutputs.Quantity.WAIT,
                "meanClientWaitMs",
                "Mean client wait",
                "Completed client connection waits.",
            ),
            SlotPoolOutputs.output(
                "clientConnections",
                SlotPoolOutputs.Quantity.WAIT_LIMIT,
                "clientWaitLimitCount",
                "Client wait limits",
                "Client wait-limit rejections.",
            ),
            SlotPoolOutputs.output(
                "serverConnections",
                SlotPoolOutputs.Quantity.QUEUE_FULL,
                "serverQueueFullCount",
                "Server queue rejections",
                "Full server-queue rejections.",
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
