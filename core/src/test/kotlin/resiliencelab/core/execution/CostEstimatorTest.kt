package resiliencelab.core.execution

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledPoint
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.engine.ksl.TestChains
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ServiceNode
import kotlin.test.Test

class CostEstimatorTest {
    private fun experiment(chain: ChainIr) =
        CompiledExperiment(
            variants = listOf(CompiledVariant("baseline", "Baseline", listOf(CompiledPoint("p0", emptyMap(), chain)))),
            run = chain.run,
        )

    @Test
    fun `estimates events rows and task sizes from IR without a model`() {
        val chain = TestChains.simple().copy(run = TestChains.run(replications = 2))

        val estimate = CostEstimator.estimate(experiment(chain), workers = 1)

        assertThat(estimate.tasks).isEqualTo(2)
        assertThat(estimate.expectedEvents).isEqualTo(586.0)
        assertThat(estimate.expectedRows).isEqualTo(600)
        assertThat(estimate.estimatedUncompressedBytes).isEqualTo(307_200)
        assertThat(estimate.estimatedArtifactBytes).isEqualTo(83_968)
        assertThat(estimate.estimatedParts).isEqualTo(2)
        assertThat(estimate.estimatedSeconds).isPositive()
        assertThat(estimate.warnings.map { it.code }).contains("ESTIMATE_EXTRAPOLATION")
    }

    @Test
    fun `workers change only estimated time`() {
        val experiment = experiment(TestChains.simple().copy(run = TestChains.run(replications = 2)))

        val one = CostEstimator.estimate(experiment, workers = 1)
        val two = CostEstimator.estimate(experiment, workers = 2)

        assertThat(two.estimatedSeconds).isLessThan(one.estimatedSeconds)
        assertThat(two.copy(workers = one.workers, estimatedSeconds = one.estimatedSeconds)).isEqualTo(one)
    }

    @Test
    fun `warns when one task exceeds the decoded UI cache budget`() {
        val base = TestChains.simple()
        val services =
            (0 until 1_400).map { index ->
                ServiceNode("service-$index", 1, 2, TestChains.fixed(1.0), 0.0)
            }
        val chain = base.copy(entry = "service-0", services = services, calls = emptyList())

        val estimate = CostEstimator.estimate(experiment(chain), workers = 1)

        assertThat(estimate.estimatedUncompressedBytes).isGreaterThan(64L * 1024 * 1024)
        assertThat(estimate.estimatedParts).isGreaterThan(1)
        assertThat(estimate.warnings.map { it.code }).contains("ESTIMATE_UI_CACHE")
    }
}
