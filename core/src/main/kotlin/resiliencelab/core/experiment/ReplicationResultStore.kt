package resiliencelab.core.experiment

import resiliencelab.core.engine.ksl.ExperimentExecutionException
import java.util.concurrent.ConcurrentSkipListMap

/**
 * Collects concurrent results for one variant by one-based replication number.
 * Duplicate records are rejected, and snapshots require exactly `1..expectedCount` in replication order.
 */
internal class ReplicationResultStore(
    private val variantId: String,
) {
    private val results = ConcurrentSkipListMap<Int, ReplicationResult>()

    fun record(
        replicationNumber: Int,
        result: ReplicationResult,
    ) {
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
