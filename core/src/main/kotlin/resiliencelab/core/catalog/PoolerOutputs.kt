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
        description: String,
    ) = SlotPoolOutputs.output(
        set,
        SlotPoolOutputs.Quantity.UTILIZATION,
        id,
        title,
        description,
        OutputTimeline("poolerResources", "Pooler connections", 3, order),
        OutputInspector(title, order, chartOrder = order),
        OutputOverlay(title, "$label {value}", "$description Interval: {interval}.", order),
    )

    private fun count(
        id: String,
        title: String,
        field: String,
        order: Int,
        description: String,
    ) = OutputDescriptor(
        id,
        title,
        description,
        OutputUnit.REQUESTS,
        OutputKind.COUNT,
        OutputCalculation(OutputCalculationKind.VALUE, field),
        OutputSummary(ratio("totals.${field.substringAfterLast('.')}", "replications"), OutputSummarySource.PER_REPLICATION),
        OutputTimeline("poolerCounts", "Pooler attempts", 0, order),
        OutputInspector(title, order + 3),
    )

    val outputs =
        listOf(
            resource(
                "serverUtilization",
                "Server pool utilization",
                "Server pool",
                "serverConnections",
                0,
                "Share of available server connection capacity used over the interval.",
            ),
            resource(
                "clientUtilization",
                "Client connection utilization",
                "Clients",
                "clientConnections",
                1,
                "Share of the client connection limit used over the interval, including clients waiting for a server " +
                    "connection or a reply.",
            ),
            SlotPoolOutputs.output(
                "serverConnections",
                SlotPoolOutputs.Quantity.QUEUE,
                "meanWaitingClients",
                "Waiting clients",
                "Average number of clients waiting for a server connection over the interval.",
                OutputTimeline("poolerQueue", "Waiting clients", 4, 0),
                OutputInspector("Waiting clients", 2, chartOrder = 2),
                OutputOverlay(
                    "Waiting clients",
                    "Waiting {value}",
                    "Average number of clients waiting for a server connection, {interval}.",
                    2,
                ),
            ),
            count(
                "offeredAttempts",
                "Offered attempts",
                "offeredAttempts",
                0,
                "Attempts reaching the pooler, including those rejected at the client connection limit. In windows: " +
                    "event count. In the summary: mean count per independent replication.",
            ),
            count(
                "admittedAttempts",
                "Admitted attempts",
                "admittedAttempts",
                1,
                "Attempts that acquired a client connection, including those waiting for a server connection. In " +
                    "windows: event count. In the summary: mean count per independent replication.",
            ),
            SlotPoolOutputs.output(
                "clientConnections",
                SlotPoolOutputs.Quantity.QUEUE_FULL,
                "clientConnectionRejections",
                "Client connection rejections",
                "Attempts rejected immediately because the client connection limit was reached. In windows: event " +
                    "count. In the summary: mean count per independent replication.",
                OutputTimeline("poolerCounts", "Pooler attempts", 0, 2),
                OutputInspector("Client connection rejections", 5),
            ),
            SlotPoolOutputs.output(
                "serverConnections",
                SlotPoolOutputs.Quantity.WAIT_LIMIT,
                "waitTimeouts",
                "Server wait timeouts",
                "Admitted attempts that did not obtain a server connection before the wait limit. In windows: event " +
                    "count. In the summary: mean count per independent replication.",
                OutputTimeline("poolerCounts", "Pooler attempts", 0, 3),
                OutputInspector("Server wait timeouts", 6),
            ),
            count(
                "successes",
                "Successful replies",
                "successes",
                4,
                "Admitted attempts that returned a successful reply. In windows: event count. In the summary: mean " +
                    "count per independent replication.",
            ),
            count(
                "failures",
                "Failed replies",
                "failures",
                5,
                "Admitted attempts that returned an unsuccessful reply, including server connection wait timeouts; " +
                    "client connection rejections are excluded. In windows: event count. In the summary: mean count per " +
                    "independent replication.",
            ),
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
                "Average number of clients waiting for a client connection over the interval; transaction mode has " +
                    "no client queue, so this is zero.",
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
