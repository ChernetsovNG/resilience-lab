package resiliencelab.core.catalog

/** The single binding builder for all slot roles, using the closed ADR 0011 operations. */
internal object SlotPoolOutputs {
    enum class Quantity { UTILIZATION, QUEUE, WAIT, QUEUE_FULL, WAIT_LIMIT, QUEUE_FULL_RATE }

    fun output(
        set: String,
        quantity: Quantity,
        id: String,
        title: String,
        description: String,
        timeline: OutputTimeline? = null,
        inspector: OutputInspector? = null,
        overlay: OutputOverlay? = null,
    ): OutputDescriptor {
        val prefix = "slotPools.$set."
        val (field, divisor) =
            when (quantity) {
                Quantity.UTILIZATION -> "busyIntegralMs" to "capacityIntegralMs"
                Quantity.QUEUE -> "queueIntegralMs" to "durationMs"
                Quantity.WAIT -> "totalWaitMs" to "waitCount"
                Quantity.QUEUE_FULL, Quantity.QUEUE_FULL_RATE -> "queueFullCount" to "durationMs"
                Quantity.WAIT_LIMIT -> "waitLimitCount" to "durationMs"
            }
        val count = quantity == Quantity.QUEUE_FULL || quantity == Quantity.WAIT_LIMIT
        val rate = quantity == Quantity.QUEUE_FULL_RATE
        val operation =
            if (count) {
                OutputCalculationKind.VALUE
            } else if (rate) {
                OutputCalculationKind.RATE
            } else {
                OutputCalculationKind.RATIO
            }
        val windowDivisor = if (divisor == "durationMs") divisor else prefix + divisor
        val summaryDivisor =
            if (count) {
                "replications"
            } else if (divisor ==
                "durationMs"
            ) {
                "totals.measurementMs"
            } else {
                "totals." + prefix + divisor
            }
        return OutputDescriptor(
            id,
            title,
            description,
            when {
                quantity == Quantity.UTILIZATION -> OutputUnit.PERCENT
                quantity == Quantity.WAIT -> OutputUnit.MILLISECONDS
                rate -> OutputUnit.PER_SECOND
                else -> OutputUnit.REQUESTS
            },
            when {
                quantity == Quantity.UTILIZATION -> OutputKind.UTILIZATION
                quantity == Quantity.WAIT -> OutputKind.LATENCY
                count -> OutputKind.COUNT
                rate -> OutputKind.RATE
                else -> OutputKind.MEAN_LEVEL
            },
            OutputCalculation(operation, prefix + field, if (count) null else windowDivisor),
            OutputSummary(
                OutputCalculation(if (count) OutputCalculationKind.RATIO else operation, "totals." + prefix + field, summaryDivisor),
                if (count) OutputSummarySource.PER_REPLICATION else OutputSummarySource.POOLED,
            ),
            timeline,
            inspector,
            overlay,
        )
    }
}
