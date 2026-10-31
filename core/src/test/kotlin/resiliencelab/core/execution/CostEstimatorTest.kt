package resiliencelab.core.execution

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledPoint
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.engine.ksl.TestChains
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.ServiceNode
import kotlin.test.Test

class CostEstimatorTest {
    @Test
    fun `uses average profile intensity and warns on long modelled time`() {
        val base = TestChains.simple()
        val ramp =
            base.copy(
                clients =
                    listOf(
                        base.client.copy(
                            classes =
                                mapOf(
                                    "default" to
                                        LoadProfile(
                                            listOf(
                                                LoadPoint(0.0, 0.0),
                                                LoadPoint(1_000.0, 0.02),
                                            ),
                                        ),
                                ),
                        ),
                    ),
            )
        assertThat(CostEstimator.estimate(experiment(ramp), 1).expectedEvents)
            .isEqualTo(CostEstimator.estimate(experiment(base), 1).expectedEvents)
        val long = base.copy(run = base.run.copy(measurementMs = 86_400_000.0))
        assertThat(CostEstimator.estimate(experiment(long), 1).warnings.map { it.code })
            .contains("ESTIMATE_LONG_MODEL_TIME")
    }

    @Test
    fun `includes connection pool acquisition and waiting for every configured attempt`() {
        val base = TestChains.simple()
        val pooled = base.copy(calls = base.calls.map { it.copy(pool = CallPool(1, 20.0)) })
        val original = CostEstimator.estimate(experiment(base), 1)
        val estimate = CostEstimator.estimate(experiment(pooled), 1)
        assertThat(estimate.expectedEvents).isGreaterThan(original.expectedEvents)
        assertThat(estimate.estimatedUncompressedBytes).isGreaterThan(original.estimatedUncompressedBytes)
    }

    @Test
    fun `includes pooler server acquisition beyond its processing and outgoing calls`() {
        val graph = replicaGraph(3)
        val withoutServerPool = graph.copy(services = graph.services.map { it.copy(pooler = null) })
        assertThat(CostEstimator.estimate(experiment(graph), 1).expectedEvents)
            .isGreaterThan(CostEstimator.estimate(experiment(withoutServerPool), 1).expectedEvents)
    }

    @Test
    fun `counts both boundaries of each expanded fault interval without request traffic`() {
        val graph = replicaGraph(3)
        val idle = graph.copy(clients = listOf(graph.client.copy(classes = mapOf("default" to LoadProfile.constant(0.0)))))
        val faults =
            listOf(
                FaultSpan("worker#1", 100.0, 200.0, FaultKind.BLACKHOLE),
                FaultSpan("to-pooler#2", 100.0, 200.0, FaultKind.CAPACITY_LOSS, capacity = 0),
            )
        val normal = CostEstimator.estimate(experiment(idle), 1)
        assertThat(CostEstimator.estimate(experiment(idle.copy(faults = faults)), 1).expectedEvents)
            .isEqualTo(normal.expectedEvents + 8.0)
    }

    @Test
    fun `replicas add instance group and router output rows in separately packed parts`() {
        val single = CostEstimator.estimate(experiment(replicaGraph(1)), 1)
        val replicas = CostEstimator.estimate(experiment(replicaGraph(3)), 1)
        assertThat(single.expectedRows).isEqualTo(216)
        assertThat(replicas.expectedRows).isEqualTo(432)
        assertThat(replicas.estimatedUncompressedBytes).isGreaterThan(single.estimatedUncompressedBytes)
        assertThat(replicas.estimatedArtifactBytes).isGreaterThan(single.estimatedArtifactBytes)
        assertThat(replicas.estimatedParts).isGreaterThanOrEqualTo(4)
        val graph = replicaGraph(3)
        val reordered = graph.copy(services = graph.services.reversed(), calls = graph.calls.reversed(), routes = graph.routes.reversed())
        assertThat(CostEstimator.estimate(experiment(reordered), 1)).isEqualTo(replicas)
        val partialWindow = graph.copy(run = graph.run.copy(measurementMs = 850.0))
        assertThat(CostEstimator.estimate(experiment(partialWindow), 1).expectedRows).isEqualTo(396)
    }

    @Test
    fun `large replica estimates name the dominant storage source in budget and duration warnings`() {
        val graph = replicaGraph(30).let { it.copy(run = it.run.copy(measurementMs = 3_600_000.0, windowMs = 1.0)) }
        val estimate = CostEstimator.estimate(experiment(graph), 1)
        for (code in listOf("ESTIMATE_UI_CACHE", "ESTIMATE_LONG_MODEL_TIME")) {
            val warning = estimate.warnings.single { it.code == code }
            assertThat(warning.args).containsEntry("storageSource", JsonPrimitive("replicaInstances"))
            assertThat(warning.message).contains("replica instances")
        }
    }

    private fun replicaGraph(replicas: Int): GraphIr {
        val model = (DocumentCodec.decodeModel(CostEstimatorArtifactTest.model(replicas), "m.model.json") as DecodeResult.Ok).value
        val experiment =
            (
                DocumentCodec.decodeExperiment(
                    CostEstimatorArtifactTest.experiment,
                    "e.experiment.json",
                ) as DecodeResult.Ok
            ).value
        return requireNotNull(ModelCompiler().compile(model, "m.model.json", experiment, "e.experiment.json").experiment)
            .variants
            .single()
            .points
            .single()
            .graph
    }

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
        assertThat(estimate.expectedRows).isEqualTo(800)
        assertThat(estimate.estimatedUncompressedBytes).isEqualTo(294_400)
        // 36,800 series + 1,024 part metadata + 3,112 compressed totals + 12,448 summary bytes.
        assertThat(estimate.estimatedArtifactBytes).isEqualTo(53_384)
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
            (0 until 1_600).map { index ->
                ServiceNode("service-$index", 1, 2, TestChains.fixed(1.0), 0.0)
            }
        val chain = base.copy(clients = base.clients.map { it.copy(entry = "service-0") }, services = services, calls = emptyList())

        val estimate = CostEstimator.estimate(experiment(chain), workers = 1)

        assertThat(estimate.estimatedUncompressedBytes).isGreaterThan(64L * 1024 * 1024)
        assertThat(estimate.estimatedParts).isGreaterThan(1)
        assertThat(estimate.warnings.map { it.code }).contains("ESTIMATE_UI_CACHE")
        val warning = estimate.warnings.single { it.code == "ESTIMATE_UI_CACHE" }
        assertThat(warning.message)
            .contains("64 MiB UI cache budget", "node rows")
        assertThat(warning.args)
            .containsEntry("cacheMiB", JsonPrimitive(64))
            .containsEntry("storageSource", JsonPrimitive("nodes"))
    }

    @Test
    fun `fixed event count does not overflow at the window limit`() {
        val base = TestChains.simple()
        val chain =
            base.copy(
                clients = listOf(base.client.copy(classes = mapOf("default" to LoadProfile.constant(0.0)))),
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
        val chain = base.copy(clients = base.clients.map { it.copy(entry = "service-0") }, services = services, calls = emptyList())

        val estimate = CostEstimator.estimate(experiment(chain), workers = 9)

        assertThat(estimate.warnings.map { it.code })
            .contains("ESTIMATE_EXTRAPOLATION")
            .doesNotContain("ESTIMATE_WORKER_EXTRAPOLATION")
        assertThat(estimate.warnings.single { it.code == "ESTIMATE_EXTRAPOLATION" }.args)
            .containsExactlyInAnyOrderEntriesOf(
                mapOf(
                    "minServices" to JsonPrimitive(50),
                    "maxServices" to JsonPrimitive(5000),
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
                clients = base.clients.map { it.copy(entry = "z-entry") },
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
