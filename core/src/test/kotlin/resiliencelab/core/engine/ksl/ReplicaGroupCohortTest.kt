package resiliencelab.core.engine.ksl

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.experiment.ReplicaGroup
import resiliencelab.core.experiment.ReplicaGroupKind
import resiliencelab.core.experiment.ReplicaMember
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.results.NodeWindow
import kotlin.test.Test

class ReplicaGroupCohortTest {
    @Test
    fun `service group residence excludes warmup cohort and includes runout completions`() {
        var time = 1.0
        val members = (1..3).map { ReplicaMember("worker#$it", it) }
        val closed = mutableListOf<NodeWindow>()
        val collector =
            MetricsCollector(
                services =
                    members.map { member ->
                        ServiceNode(listOf("worker", "#${member.replica}"), 1, 10, Distribution(DistributionShape.FIXED, 1.0), 0.0)
                    },
                measurementStartMs = 10.0,
                measurementEndMs = 20.0,
                currentTimeMs = { time },
                windowMs = 10.0,
                groups = listOf(ReplicaGroup("worker", ReplicaGroupKind.NODE, members)),
                onWindow = { _, nodes, _ -> closed += nodes },
            )
        collector.recordAttemptCompletion("worker#1", 1.0, succeeded = true, measured = false)
        time = 11.0
        collector.recordAttemptCompletion("worker#2", 0.0, succeeded = true)
        time = 25.0
        collector.recordAttemptCompletion("worker#3", 14.0, succeeded = true)
        val result = collector.replicationResult()
        assertThat(
            result.services
                .getValue("worker")
                .latency.count,
        ).isEqualTo(2)
        assertThat(
            result.services
                .getValue("worker")
                .latency.sumMs,
        ).isEqualTo(14.0)
        val windows = closed.filter { it.id == "worker" }.map { it.metrics }
        assertThat(windows.map { it.latency.count }).containsExactly(1L, 1L)
        assertThat(windows.map { it.latency.sumMs }).containsExactly(1.0, 0.0)
    }
}
