package resiliencelab.core.catalog

/** The existing Stage 1 UI quantities, including their distinct window and summary populations. */
internal object Stage1Outputs {
    private fun calculation(
        kind: OutputCalculationKind,
        field: String,
        divisor: String? = null,
        capacity: String? = null,
    ) = OutputCalculation(kind, field, divisor, capacity)

    private fun ratio(
        field: String,
        divisor: String,
    ) = calculation(OutputCalculationKind.RATIO, field, divisor)

    private fun pooled(
        field: String,
        divisor: String,
    ) = OutputSummary(ratio("totals.$field", "totals.$divisor"))

    private fun rate(
        field: String,
        title: String,
        group: String,
        order: Int,
        summary: Boolean = false,
    ) = OutputDescriptor(
        id = "${field}PerSecond",
        title = title,
        description = "$title per second, using the actual window duration.",
        unit = OutputUnit.PER_SECOND,
        kind = OutputKind.RATE,
        calculation = calculation(OutputCalculationKind.RATE, field, "durationMs"),
        summary =
            if (summary) {
                OutputSummary(
                    calculation(OutputCalculationKind.RATE, "totals.$field", "totals.measurementMs"),
                )
            } else {
                null
            },
        timeline =
            OutputTimeline(
                group,
                if (group ==
                    "rates"
                ) {
                    "Rates"
                } else {
                    "Errors and rejections"
                },
                if (group == "rates") 0 else 2,
                order,
            ),
    )

    private fun latencies(
        service: Boolean = false,
        call: Boolean = false,
    ): List<OutputDescriptor> =
        listOf("mean" to null, "p50" to 0.50, "p95" to 0.95, "p99" to 0.99).mapIndexed { index, (name, percentile) ->
            val mean = percentile == null
            OutputDescriptor(
                id = "${name}LatencyMs",
                title = if (mean) "Mean latency" else "$name latency",
                description =
                    if (call) {
                        "Received-response duration; timed out attempts have no latency sample."
                    } else if (service) {
                        "Service residence time, including queueing and handler holding; queue rejections have no sample."
                    } else {
                        "Original-request latency in its completion window."
                    },
                unit = OutputUnit.MILLISECONDS,
                kind = OutputKind.LATENCY,
                calculation =
                    OutputCalculation(
                        if (mean) OutputCalculationKind.MEAN else OutputCalculationKind.QUANTILE,
                        "latency",
                        percentile = percentile,
                    ),
                summary =
                    when {
                        mean && service ->
                            OutputSummary(
                                calculation(OutputCalculationKind.MEAN, "measurementLatency"),
                                OutputSummarySource.REPLICATION,
                            )
                        mean && call -> OutputSummary(calculation(OutputCalculationKind.VALUE, "pooledLatency.meanMs"))
                        else -> null
                    },
                timeline = OutputTimeline("latency", "Latency", 1, index),
                inspector =
                    when {
                        mean && service -> OutputInspector("Mean latency", 5)
                        mean && call -> OutputInspector("Mean call duration", 7, chartOrder = 2, thresholdParameter = "timeout")
                        else -> null
                    },
            )
        }

    val client: List<OutputDescriptor> =
        listOf(
            rate("originalArrivals", "Original requests", "rates", 1),
            rate("successes", "Successes", "rates", 4),
            rate("failures", "Failures", "errors", 0),
            rate("degraded", "Successful requests with fallback", "rates", 6),
        ) + latencies()

    val service: List<OutputDescriptor> =
        listOf(
            rate("offeredAttempts", "Offered attempts", "rates", 2),
            rate("admittedAttempts", "Admitted attempts", "rates", 3, summary = true)
                .copy(inspector = OutputInspector("Admitted attempts", 4)),
            rate("successes", "Successes", "rates", 4),
            rate("retries", "Retries", "rates", 5),
            rate("failures", "Failures", "errors", 0),
            rate("timeouts", "Timeouts", "errors", 1),
            SlotPoolOutputs.output(
                "handlers",
                SlotPoolOutputs.Quantity.QUEUE_FULL_RATE,
                "queueRejectionsPerSecond",
                "Queue rejections",
                "Queue rejections per second, using the actual window duration.",
                timeline = OutputTimeline("errors", "Errors and rejections", 2, 3),
            ),
            SlotPoolOutputs.output(
                "handlers",
                SlotPoolOutputs.Quantity.UTILIZATION,
                "utilization",
                "Handler utilization",
                "Busy handler time divided by available handler time.",
                OutputTimeline("utilization", "Utilization", 3, 0),
                OutputInspector("Handler utilization", 0, chartOrder = 0),
                OutputOverlay("Utilization", "Util. {value}", "Busy handler time / handler capacity time, {interval}.", 0),
            ),
            SlotPoolOutputs.output(
                "handlers",
                SlotPoolOutputs.Quantity.QUEUE,
                "meanQueue",
                "Mean queue",
                "Queue length integral divided by interval duration.",
                OutputTimeline("queue", "Queue", 5, 0),
                OutputInspector("Mean queue", 1, chartOrder = 1),
                OutputOverlay(
                    "Mean queue",
                    "Queue {value}",
                    "Queue length integral / interval duration, {interval}.",
                    1,
                    scaleParameter = "queue",
                    scaleTitle = "Queue fill",
                ),
            ),
            OutputDescriptor(
                "queueFill",
                "Queue fill",
                "Mean queue divided by effective queue capacity; no value when queueing is disabled.",
                OutputUnit.PERCENT,
                OutputKind.FRACTION,
                calculation(OutputCalculationKind.NORMALIZED_RATIO, "slotPools.handlers.queueIntegralMs", "durationMs", "params.queue"),
                OutputSummary(
                    calculation(
                        OutputCalculationKind.NORMALIZED_RATIO,
                        "totals.slotPools.handlers.queueIntegralMs",
                        "totals.measurementMs",
                        "params.queue",
                    ),
                ),
                inspector = OutputInspector("Queue fill", 2),
            ),
            OutputDescriptor(
                "queueRejectionRate",
                "Queue rejection share",
                "Rejected attempts divided by offered attempts.",
                OutputUnit.PERCENT,
                OutputKind.FRACTION,
                ratio("slotPools.handlers.queueFullCount", "offeredAttempts"),
                pooled("slotPools.handlers.queueFullCount", "offeredAttempts"),
                inspector = OutputInspector("Queue rejection share", 3),
                overlay =
                    OutputOverlay(
                        "Queue rejections",
                        "Rejected {value}",
                        "Queue rejections / offered attempts, {interval}.",
                        2,
                    ),
            ),
            SlotPoolOutputs.output(
                "handlers",
                SlotPoolOutputs.Quantity.WAIT,
                "meanWaitMs",
                "Mean handler wait",
                "Completed FIFO waits, including expiry.",
            ),
            SlotPoolOutputs.output(
                "handlers",
                SlotPoolOutputs.Quantity.WAIT_LIMIT,
                "waitLimitCount",
                "Handler wait limits",
                "Wait-limit rejections per replication.",
            ),
        ) + latencies(service = true)

    /** Database rows reuse service statistics, with connection and query terminology in every view. */
    val database: List<OutputDescriptor> =
        service.filterNot { it.id in setOf("retriesPerSecond", "timeoutsPerSecond") }.map { output ->
            val (title, description) =
                when (output.id) {
                    "offeredAttemptsPerSecond" ->
                        "Offered queries" to
                            "Queries arriving at the database per second, including queue rejections."
                    "admittedAttemptsPerSecond" -> "Admitted queries" to "Queries admitted for execution or FIFO waiting per second."
                    "successesPerSecond" -> "Successful queries" to "Successfully completed queries per second."
                    "failuresPerSecond" -> "Failed queries" to "Executed queries that failed per second; excludes queue rejections."
                    "queueRejectionsPerSecond" ->
                        "Query queue rejections" to
                            "Queries rejected per second when connections and the query queue are full."
                    "utilization" -> "Connection utilization" to "Busy connection time divided by available connection time."
                    "meanQueue" -> "Mean query queue" to "Waiting-query integral divided by interval duration."
                    "queueFill" ->
                        "Query queue fill" to
                            "Mean waiting queries divided by query queue capacity; no value when queueing is disabled."
                    "queueRejectionRate" -> "Query rejection share" to "Rejected queries divided by offered queries."
                    "meanWaitMs" -> "Mean connection wait" to "Completed database connection waits, including expiry."
                    "waitLimitCount" -> "Connection wait limits" to "Database connection wait-limit rejections per replication."
                    else ->
                        output.title to
                            "Query residence time, including FIFO waiting and execution; rejected queries have no latency sample."
                }
            output.copy(
                title = title,
                description = description,
                inspector = output.inspector?.copy(title = title),
                timeline =
                    output.timeline?.let { timeline ->
                        when (output.id) {
                            "utilization" -> timeline.copy(groupTitle = "Connection utilization")
                            "meanQueue" -> timeline.copy(groupTitle = "Query queue")
                            else -> timeline
                        }
                    },
                overlay =
                    output.overlay?.let { overlay ->
                        when (output.id) {
                            "utilization" ->
                                overlay.copy(
                                    label = "Connections {value}",
                                    description = "Busy connection time / connection capacity time, {interval}.",
                                )
                            "meanQueue" ->
                                overlay.copy(
                                    label = "Queue {value}",
                                    description = "Waiting-query integral / interval duration, {interval}.",
                                    scaleTitle = "Query queue fill",
                                )
                            "queueRejectionRate" ->
                                overlay.copy(
                                    label = "Rejected {value}",
                                    description = "Rejected queries / offered queries, {interval}.",
                                )
                            else -> overlay
                        }
                    },
            )
        }

    private fun occupancy(
        id: String,
        field: String,
        title: String,
        inspectorTitle: String,
        order: Int,
        inspectorOrder: Int,
    ) = OutputDescriptor(
        id,
        title,
        "Occupancy integral divided by interval duration.",
        OutputUnit.REQUESTS,
        OutputKind.MEAN_LEVEL,
        ratio(field, "durationMs"),
        pooled(field, "measurementMs"),
        OutputTimeline("callState", "Call state", 4, order),
        OutputInspector(inspectorTitle, inspectorOrder),
    )

    private val amplification =
        OutputDescriptor(
            "amplification",
            "Attempts per request",
            "Attempts admitted by the destination per original client request; values below 1 mean that not every request reached it.",
            OutputUnit.MULTIPLIER,
            OutputKind.RATIO,
            ratio("target.admittedAttempts", "entries.total.originalArrivals"),
            OutputSummary(
                calculation(OutputCalculationKind.VALUE, "target.admittedAmplification.mean"),
                intervalField = "target.admittedAmplification",
            ),
            overlay =
                OutputOverlay(
                    "Attempts per request",
                    "Attempts per request {value}",
                    "Attempts admitted by the destination per original request, averaged across replications.",
                    0,
                    windowDescription =
                        "Window approximation: admitted attempts / original client arrivals; " +
                            "attempts may belong to earlier requests.",
                ),
            approximateWindow = true,
        )

    // Request has no own row; its existing canvas badge refers to the target service.
    val request: List<OutputDescriptor> = listOf(amplification)

    val call: List<OutputDescriptor> =
        listOf(
            rate("sentAttempts", "Sent attempts", "rates", 0, summary = true).copy(
                inspector = OutputInspector("Sent attempts", 0, chartOrder = 0),
                overlay = OutputOverlay("Sent attempts", "Sent attempts {value}", "Sent attempts", 1),
            ),
            rate("retries", "Retries", "rates", 5, summary = true).copy(inspector = OutputInspector("Retries", 1)),
            rate("succeeded", "Successes", "rates", 4).copy(id = "successesPerSecond"),
            rate("failed", "Failures", "errors", 0).copy(id = "failuresPerSecond"),
            rate("timeouts", "Timeouts", "errors", 1).copy(inspector = OutputInspector("Timeouts", 0, showValue = false, chartOrder = 1)),
            rate("orphaned", "Orphaned attempts", "errors", 2),
            rate("circuitRejections", "Circuit rejections", "errors", 4, summary = true),
            rate("retriesDenied", "Retries denied by budget", "errors", 5, summary = true),
            rate("fallbacks", "Fallbacks", "rates", 6, summary = true),
            OutputDescriptor(
                "circuitOpenShare",
                "Circuit open share",
                "Open caller-instance time divided by interval duration; grouped connections sum their instance shares.",
                OutputUnit.PERCENT,
                OutputKind.FRACTION,
                ratio("circuitOpenMs", "durationMs"),
                pooled("circuitOpenMs", "measurementMs"),
                OutputTimeline("circuit", "Circuit breaker", 8, 0),
            ),
            occupancy("meanInFlight", "inFlightIntegralMs", "Mean in-flight", "Mean in flight", 0, 5).let {
                it.copy(summary = it.summary!!.copy(intervalField = "meanInFlight"))
            },
            occupancy("meanOrphaned", "orphanedIntegralMs", "Mean orphaned work", "Mean orphaned work", 1, 4).copy(
                overlay = OutputOverlay("Orphaned work", "Orphaned work {value}", "Orphaned work", 3),
            ),
            occupancy("meanBackoff", "backoffIntegralMs", "Mean backoff", "Mean backoff", 2, 6),
            OutputDescriptor(
                "timeoutRate",
                "Timeout share",
                "Timed out attempts divided by sent attempts.",
                OutputUnit.PERCENT,
                OutputKind.FRACTION,
                ratio("timeouts", "sentAttempts"),
                pooled("timeouts", "sentAttempts").copy(intervalField = "timeoutRate"),
                inspector = OutputInspector("Timeout share", 2),
                overlay = OutputOverlay("Timeout share", "Timeout share {value}", "Timeout share", 2),
            ),
            OutputDescriptor(
                "orphaned",
                "Orphaned attempts",
                "Attempts whose downstream work was still running when the caller stopped waiting.",
                OutputUnit.REQUESTS,
                OutputKind.COUNT,
                calculation(OutputCalculationKind.VALUE, "orphaned"),
                OutputSummary(ratio("totals.orphaned", "replications"), OutputSummarySource.PER_REPLICATION),
                inspector = OutputInspector("Orphaned attempts", 3),
            ),
            SlotPoolOutputs.output(
                "pool",
                SlotPoolOutputs.Quantity.UTILIZATION,
                "poolUtilization",
                "Connection pool utilization",
                "Occupied connection time divided by available pool capacity time; absent pools have no utilization.",
                OutputTimeline("poolUtilization", "Pool utilization", 6, 0),
                OutputInspector("Connection pool utilization", 9),
            ),
            SlotPoolOutputs.output(
                "pool",
                SlotPoolOutputs.Quantity.QUEUE,
                "meanPoolQueue",
                "Mean connection wait queue",
                "Integral of callers waiting for a connection divided by interval duration.",
                OutputTimeline("pool", "Connection pool", 7, 0),
                OutputInspector("Mean connection wait queue", 10),
            ),
            SlotPoolOutputs.output(
                "pool",
                SlotPoolOutputs.Quantity.WAIT_LIMIT,
                "poolAcquireTimeouts",
                "Connection acquisition timeouts",
                "Attempts rejected by the acquisition timeout before sending; deadline expiry is excluded.",
                OutputTimeline("pool", "Connection pool", 7, 1),
                OutputInspector("Connection acquisition timeouts", 11),
            ),
            amplification.copy(inspector = OutputInspector("Attempts per request", 8)),
            SlotPoolOutputs.output(
                "pool",
                SlotPoolOutputs.Quantity.WAIT,
                "meanPoolWaitMs",
                "Mean pool wait",
                "Completed connection waits, including expiry.",
            ),
            SlotPoolOutputs.output(
                "pool",
                SlotPoolOutputs.Quantity.QUEUE_FULL,
                "poolQueueFullCount",
                "Pool queue rejections",
                "Full-queue rejections per replication.",
            ),
        ) + latencies(call = true)
}
