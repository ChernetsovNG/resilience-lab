package resiliencelab.core.catalog

/** T2.2 outputs read the already-versioned policy counters and readiness integrals. */
internal object ServicePolicyOutputs {
    private fun rate(
        id: String,
        field: String,
        title: String,
        order: Int,
    ) = OutputDescriptor(
        id,
        title,
        "$title per second, using the actual interval duration.",
        OutputUnit.PER_SECOND,
        OutputKind.RATE,
        OutputCalculation(OutputCalculationKind.RATE, field, "durationMs"),
        OutputSummary(OutputCalculation(OutputCalculationKind.RATE, "totals.$field", "totals.measurementMs")),
        OutputTimeline("servicePolicies", "Service policies", 8, order),
    )

    val outputs =
        listOf(
            rate("rateLimitedPerSecond", "rateLimited", "Rate-limit rejections", 0),
            OutputDescriptor(
                "rateLimitedRate",
                "Rate-limited share",
                "Attempts rejected before the handler queue divided by all offered attempts.",
                OutputUnit.PERCENT,
                OutputKind.FRACTION,
                OutputCalculation(OutputCalculationKind.RATIO, "rateLimited", "offeredAttempts"),
                OutputSummary(OutputCalculation(OutputCalculationKind.RATIO, "totals.rateLimited", "totals.offeredAttempts")),
                OutputTimeline("servicePolicies", "Service policies", 8, 1),
            ),
            rate("probeFailuresPerSecond", "probeFailures", "Failed health probes", 2),
            OutputDescriptor(
                "notReadyShare",
                "Not-ready share",
                "Not-ready instance time divided by interval duration; replica groups sum their instance shares.",
                OutputUnit.PERCENT,
                OutputKind.FRACTION,
                OutputCalculation(OutputCalculationKind.RATIO, "notReadyMs", "durationMs"),
                OutputSummary(OutputCalculation(OutputCalculationKind.RATIO, "totals.notReadyMs", "totals.measurementMs")),
                OutputTimeline("readiness", "Readiness", 9, 0),
            ),
        )
}
