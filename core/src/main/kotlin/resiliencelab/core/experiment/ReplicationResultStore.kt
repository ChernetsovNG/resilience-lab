package resiliencelab.core.experiment

import resiliencelab.core.simulation.ExperimentExecutionException
import java.util.concurrent.ConcurrentSkipListMap

internal class ReplicationResultStore(
    private val variantId: String,
) {
    private val results = ConcurrentSkipListMap<Int, ReplicationResult>()

    fun record(replicationNumber: Int, result: ReplicationResult) {
        val previous = results.putIfAbsent(replicationNumber, result)
        if (previous != null) {
            throw ExperimentExecutionException(
                "Variant '$variantId' produced duplicate replication $replicationNumber",
            )
        }
    }

    fun snapshot(expectedCount: Int): List<ReplicationResult> {
        val snapshot = results.toMap()
        val expectedNumbers = (1..expectedCount).toSet()
        if (snapshot.keys != expectedNumbers) {
            throw ExperimentExecutionException(
                "Variant '$variantId' completed ${snapshot.size} of $expectedCount replications",
            )
        }
        return snapshot.values.toList()
    }
}
