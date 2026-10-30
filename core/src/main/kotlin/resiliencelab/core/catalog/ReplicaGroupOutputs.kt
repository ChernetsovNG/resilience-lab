package resiliencelab.core.catalog

/** Group rows use the existing closed operations and remain hidden until the T4 group views. */
internal object ReplicaGroupOutputs {
    fun outputs(set: String): List<OutputDescriptor> {
        fun extreme(
            id: String,
            field: String,
            title: String,
            unit: OutputUnit,
        ) = OutputDescriptor(
            id,
            title,
            "Across group instances in the same interval; equal maxima select the lower replica number.",
            unit,
            if (unit == OutputUnit.PERCENT) OutputKind.UTILIZATION else OutputKind.MEAN_LEVEL,
            OutputCalculation(OutputCalculationKind.VALUE, "slotPools.$set.replicaExtrema.$field"),
            OutputSummary(OutputCalculation(OutputCalculationKind.VALUE, "totals.slotPools.$set.replicaExtrema.$field")),
        )

        fun mean(
            id: String,
            quantity: SlotPoolOutputs.Quantity,
            title: String,
            field: String,
        ): OutputDescriptor {
            val output = SlotPoolOutputs.output(set, quantity, id, title, "Group totals with replication-level uncertainty.")
            return output.copy(summary = requireNotNull(output.summary).copy(intervalField = "slotPoolSummaries.$set.$field"))
        }
        return listOf(
            extreme("minReplicaUtilization", "minUtilization", "Lowest replica utilization", OutputUnit.PERCENT),
            extreme("maxReplicaUtilization", "maxUtilization", "Highest replica utilization", OutputUnit.PERCENT),
            extreme("minReplicaMeanQueue", "minMeanQueueLength", "Lowest replica mean queue", OutputUnit.REQUESTS),
            extreme("maxReplicaMeanQueue", "maxMeanQueueLength", "Highest replica mean queue", OutputUnit.REQUESTS),
            mean("groupUtilization", SlotPoolOutputs.Quantity.UTILIZATION, "Group utilization", "utilization"),
            mean("groupMeanQueue", SlotPoolOutputs.Quantity.QUEUE, "Group mean queue", "meanQueueLength"),
            mean("groupMeanWaitMs", SlotPoolOutputs.Quantity.WAIT, "Group mean wait", "meanWaitMs"),
            OutputDescriptor(
                "groupMeanLatencyMs",
                "Group mean latency",
                "Merged group latency observations of the measured arrival cohort, including run-out.",
                OutputUnit.MILLISECONDS,
                OutputKind.LATENCY,
                OutputCalculation(OutputCalculationKind.MEAN, "latency"),
                OutputSummary(OutputCalculation(OutputCalculationKind.VALUE, "pooledLatency.meanMs"), intervalField = "meanLatencyMs"),
            ),
            OutputDescriptor(
                "groupP99LatencyMs",
                "Group p99 latency",
                "The p99 of merged group latency sketches; instance percentiles are never averaged.",
                OutputUnit.MILLISECONDS,
                OutputKind.LATENCY,
                OutputCalculation(OutputCalculationKind.QUANTILE, "latency", percentile = 0.99),
                OutputSummary(OutputCalculation(OutputCalculationKind.VALUE, "pooledLatency.p99Ms")),
            ),
        )
    }
}
