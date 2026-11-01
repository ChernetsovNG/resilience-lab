package resiliencelab.core.catalog

/** Ejection events and summed exclusion time from every router targeting a service instance. */
internal object OutlierDetectionOutputs {
    val outputs =
        listOf(
            OutputDescriptor(
                "ejectionsCount",
                "Ejections",
                "Ejections starting within the interval, summed over routers targeting this instance.",
                OutputUnit.REQUESTS,
                OutputKind.COUNT,
                OutputCalculation(OutputCalculationKind.VALUE, "ejections"),
                OutputSummary(OutputCalculation(OutputCalculationKind.VALUE, "totals.ejections")),
                OutputTimeline("outlierDetection", "Outlier detection", 10, 0),
                OutputInspector("Ejections", 24),
            ),
            OutputDescriptor(
                "ejectedShare",
                "Ejected share",
                "Excluded time divided by interval duration, summed over routers and replica instances.",
                OutputUnit.PERCENT,
                OutputKind.FRACTION,
                OutputCalculation(OutputCalculationKind.RATIO, "ejectedMs", "durationMs"),
                OutputSummary(OutputCalculation(OutputCalculationKind.RATIO, "totals.ejectedMs", "totals.measurementMs")),
                OutputTimeline("outlierDetection", "Outlier detection", 10, 1),
                OutputInspector("Ejected share", 25),
            ),
        )
}
