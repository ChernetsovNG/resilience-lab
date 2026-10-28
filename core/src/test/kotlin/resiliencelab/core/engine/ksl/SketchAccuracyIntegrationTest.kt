package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import ksl.simulation.ModelElement
import ksl.utilities.statistic.Statistic
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.LatencyStatistics
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.results.NodeWindow
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class SketchAccuracyIntegrationTest {
    @Test
    fun `retry storm sketch quantiles stay within one over 128 of exact observations`() {
        val root = Path.of(System.getProperty("resilience-lab.project-root"), "examples", "retry-storm")
        val model = (DocumentCodec.decodeModel(Files.readString(root.resolve("retry-storm.model.json")), "model") as DecodeResult.Ok).value
        val experiment =
            (
                DocumentCodec.decodeExperiment(
                    Files.readString(root.resolve("retry-storm.experiment.json")),
                    "experiment",
                ) as DecodeResult.Ok
            ).value
        val compiled = requireNotNull(ModelCompiler().compile(model, "model", experiment, "experiment").experiment)
        val plan =
            StreamPlan(
                compiled.variants.flatMap { variant ->
                    (0 until compiled.run.replications).flatMap { PathStreams.keys(variant.chain, it) }
                },
            )
        compiled.variants.forEach { variant ->
            repeat(compiled.run.replications) { replication ->
                val successful = mutableListOf<Double>()
                val failed = mutableListOf<Double>()
                val all = mutableListOf<Double>()
                val result =
                    ReliabilityModel(
                        Model("sketch-accuracy", autoCSVReports = false),
                        variant.chain,
                        PathStreamSource(plan, compiled.run.seed, replication.toLong()),
                        onOriginalCompletion = { latency, succeeded ->
                            all += latency
                            if (succeeded) successful += latency else failed += latency
                        },
                    ).runReplication()
                listOf(result.allLatency to all, result.successfulLatency to successful, result.failedLatency to failed)
                    .forEach { (statistics, exact) -> assertAccuracy(statistics, exact) }
            }
        }
    }

    @Test
    fun `windows include warmup completions while cohort totals include runout completions`() {
        val settings = RunSettings(1, 10.0, 15.0, 42L, 30L, windowMs = 10.0)
        val chain =
            ChainIr(
                ClientNode("client", 0.1, 1000.0),
                "service",
                listOf(ServiceNode("service", 1, 10, Distribution(DistributionShape.FIXED, 20.0), 0.0)),
                emptyList(),
                emptyList(),
                settings,
            )
        val windows = mutableListOf<List<NodeWindow>>()
        val model = Model("event-time", autoCSVReports = false)
        val engine =
            ReliabilityModel(
                model,
                chain,
                PathStreamSource(StreamPlan(PathStreams.keys(chain, 0)), settings.seed, 0),
                onWindow = { _, rows -> windows += rows },
            )
        object : ModelElement(model, name = "invocation-driver") {
            override fun initialize() {
                engine.invoke("service", originalRequest = true, measurementCohort = false)
                engine.invoke("service", timeUntilActivation = 11.0, originalRequest = true)
                engine.invoke("service", timeUntilActivation = 24.0, originalRequest = true)
            }
        }
        model.lengthOfReplication = 100.0
        model.simulate()
        val result = engine.metrics.replicationResult()
        val client = windows.map { rows -> rows.single { it.id == "client" }.metrics }
        assertThat(client.sumOf { it.successes }).isEqualTo(1)
        assertThat(client.sumOf { it.originalArrivals }).isEqualTo(3)
        assertThat(result.successes).isEqualTo(2)
        assertThat(result.originalArrivals).isEqualTo(2)
        assertThat(client.last().durationMs).isEqualTo(5.0)
        val services = windows.map { rows -> rows.single { it.id == "service" }.metrics }
        assertThat(services.sumOf { it.busyHandlerTimeMs }).isEqualTo(25.0)
        assertThat(services.sumOf { it.latency.count }).isEqualTo(1L)
        assertThat(result.services.getValue("service").handlerUtilization).isEqualTo(1.0)
    }

    private fun assertAccuracy(
        actual: LatencyStatistics,
        exact: List<Double>,
    ) {
        assertThat(actual.count).isEqualTo(exact.size.toLong())
        assertThat(actual.sumMs).isCloseTo(exact.sum(), offset(1e-9))
        val sketch = LatencySketch.fromBins(actual.sketch)
        for (p in listOf(0.95, 0.99)) {
            if (exact.isEmpty()) {
                assertThat(sketch.percentile(p)).isNull()
            } else {
                val expected = Statistic.percentile(exact.toDoubleArray(), p)
                assertThat(sketch.percentile(p)!!).isCloseTo(expected, offset(expected / 128 + 1e-10))
            }
        }
    }
}
