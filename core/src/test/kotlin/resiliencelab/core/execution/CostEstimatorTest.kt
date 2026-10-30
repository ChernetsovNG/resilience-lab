package resiliencelab.core.execution

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledPoint
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.engine.ksl.TestChains
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.ServiceNode
import kotlin.test.Test

class CostEstimatorTest {
    private fun experiment(chain: GraphIr) =
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
        assertThat(estimate.warnings.map { it.code }).doesNotContain("ESTIMATE_EXTRAPOLATION")
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
        val warning = estimate.warnings.single { it.code == "ESTIMATE_UI_CACHE" }
        assertThat(warning.message)
            .isEqualTo("Estimated uncompressed task data exceed the 64 MiB UI cache budget; load selected nodes only")
        assertThat(Json.encodeToJsonElement(warning).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"cacheMiB":64}"""))
    }

    @Test
    fun `fixed event count does not overflow at the window limit`() {
        val base = TestChains.simple()
        val chain =
            base.copy(
                client = base.client.copy(arrivalRatePerMs = 0.0),
                run = base.run.copy(measurementMs = Int.MAX_VALUE.toDouble(), windowMs = 1.0),
            )

        val estimate = CostEstimator.estimate(experiment(chain), workers = 1)

        assertThat(estimate.expectedEvents).isEqualTo(Int.MAX_VALUE.toDouble() + 3)
    }

    @Test
    fun `rejects task count overflow without expanding replications`() {
        val chain = TestChains.simple().copy(run = TestChains.run(replications = Int.MAX_VALUE / 2 + 1))
        val first = experiment(chain)
        val variant = first.variants.single()
        val second = variant.copy(id = "second", points = listOf(CompiledPoint("p0", emptyMap(), chain)))
        val experiment = first.copy(variants = listOf(variant, second))

        assertThatThrownBy { CostEstimator.estimate(experiment, workers = 1) }.isInstanceOf(ArithmeticException::class.java)
    }

    @Test
    fun `model extrapolation warning remains independent of workers`() {
        val base = TestChains.simple()
        val services = (0 until 5_001).map { index -> ServiceNode("service-$index", 1, 2, TestChains.fixed(1.0), 0.0) }
        val chain = base.copy(entry = "service-0", services = services, calls = emptyList())

        val estimate = CostEstimator.estimate(experiment(chain), workers = 9)

        assertThat(estimate.warnings.map { it.code })
            .contains("ESTIMATE_EXTRAPOLATION")
            .doesNotContain("ESTIMATE_WORKER_EXTRAPOLATION")
        assertThat(estimate.warnings.single { it.code == "ESTIMATE_EXTRAPOLATION" }.args)
            .containsExactlyInAnyOrderEntriesOf(
                mapOf(
                    "minServices" to kotlinx.serialization.json.JsonPrimitive(50),
                    "maxServices" to kotlinx.serialization.json.JsonPrimitive(5000),
                ),
            )
    }

    @Test
    fun `worker extrapolation keeps conservative time without warning`() {
        listOf(4, 16).forEach { replications ->
            val experiment = experiment(TestChains.simple().copy(run = TestChains.run(replications = replications)))

            val eight = CostEstimator.estimate(experiment, workers = 8)
            val sixteen = CostEstimator.estimate(experiment, workers = 16)

            assertThat(sixteen.warnings.map { it.code }).doesNotContain("ESTIMATE_WORKER_EXTRAPOLATION")
            assertThat(sixteen.estimatedSeconds).isGreaterThanOrEqualTo(eight.estimatedSeconds)
        }
    }

    @Test
    fun `renaming a chain across alphabetical order leaves its estimate unchanged`() {
        val base = TestChains.simple()
        val renamed =
            base.copy(
                entry = "z-entry",
                services =
                    base.services
                        .map {
                            it.copy(pathSegments = listOf(if (it.path == "entry") "z-entry" else "a-backend"))
                        }.reversed(),
                calls = base.calls.map { it.copy(from = "z-entry", to = "a-backend") },
            )
        val original = CostEstimator.estimate(experiment(base), workers = 1)
        val reordered = CostEstimator.estimate(experiment(renamed), workers = 1)
        assertThat(reordered).isEqualTo(original)
    }
}
