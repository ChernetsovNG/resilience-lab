package io.github.chernetsovng.resiliencelab.core.experiment

import io.github.chernetsovng.resiliencelab.core.scenario.DistributionKind
import io.github.chernetsovng.resiliencelab.core.scenario.DurationDistribution
import io.github.chernetsovng.resiliencelab.core.scenario.Execution
import io.github.chernetsovng.resiliencelab.core.scenario.ExperimentDocument
import io.github.chernetsovng.resiliencelab.core.scenario.ExperimentVariant
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import io.github.chernetsovng.resiliencelab.core.scenario.ScenarioValidationException
import io.github.chernetsovng.resiliencelab.core.scenario.SweepParameter
import io.github.chernetsovng.resiliencelab.core.scenario.TestData
import io.github.chernetsovng.resiliencelab.core.simulation.ExperimentExecutionException
import io.github.chernetsovng.resiliencelab.core.simulation.SeedFactory
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Tag
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ExperimentRunnerTest {
    @Test
    fun `same document produces identical results`() {
        val document = document(
            variants = listOf(
                variant(id = "baseline", scenario = scenario(processing = fixed(1.0))),
                variant(id = "candidate", scenario = scenario(processing = fixed(2.0))),
            ),
        )

        val first = ExperimentRunner.run(document)
        val second = ExperimentRunner.run(document)

        assertEquals(first, second)
    }

    @Test
    fun `different seeds change arrival streams`() {
        val variants = listOf(variant(id = "baseline"))

        val first = ExperimentRunner.run(document(variants = variants, seed = 42L))
        val second = ExperimentRunner.run(document(variants = variants, seed = 43L))

        assertNotEquals(
            first.variants.single().replications.map { it.arrivalTimesMs },
            second.variants.single().replications.map { it.arrivalTimesMs },
        )
    }

    @Test
    fun `paired variants share arrival timestamps`() {
        val result = ExperimentRunner.run(
            document(
                variants = listOf(
                    variant(id = "baseline", scenario = scenario(processing = fixed(1.0))),
                    variant(id = "candidate", scenario = scenario(processing = fixed(2.0))),
                ),
                replications = 3,
            ),
        )
        val baseline = result.variants[0].replications
        val candidate = result.variants[1].replications

        baseline.indices.forEach { index ->
            assertEquals(baseline[index].arrivalTimesMs, candidate[index].arrivalTimesMs)
        }
    }

    @Test
    fun `replications use consecutive substreams in result order`() {
        val executionSeed = 42L
        val measurementMs = 100.0
        val arrivalRate = 0.25
        val result = ExperimentRunner.run(
            document(
                variants = listOf(
                    variant(
                        id = "baseline",
                        scenario = scenario(arrivalRate = arrivalRate, processing = fixed(0.0)),
                    ),
                ),
                replications = 3,
                measurementMs = measurementMs,
                seed = executionSeed,
            ),
        )

        val expected = expectedArrivalReplications(
            seed = executionSeed,
            arrivalRate = arrivalRate,
            measurementMs = measurementMs,
            replications = 3,
        )
        val actual = result.variants.single().replications.map { it.arrivalTimesMs }
        assertEquals(expected, actual)
        assertNotEquals(actual[0], actual[1])
    }

    @Test
    fun `result metadata ordering and serialization match the experiment contract`() {
        val result = ExperimentRunner.run(
            document(
                variants = listOf(
                    variant(
                        id = "sweep-1",
                        label = "Arrival rate 0.25",
                        sweepParameter = SweepParameter.ARRIVAL_RATE,
                        sweepValue = 0.25,
                    ),
                    variant(id = "baseline", label = "Baseline"),
                ),
                replications = 2,
            ),
        )

        assertEquals(1, result.schemaVersion)
        assertEquals("0.1.0", result.applicationVersion)
        assertEquals("R1.8.1", result.kslVersion)
        assertEquals(listOf("sweep-1", "baseline"), result.variants.map { it.id })
        assertEquals(listOf("Arrival rate 0.25", "Baseline"), result.variants.map { it.label })
        assertEquals(SweepParameter.ARRIVAL_RATE, result.variants[0].sweepParameter)
        assertEquals(0.25, result.variants[0].sweepValue)
        assertNull(result.variants[1].sweepParameter)
        assertNull(result.variants[1].sweepValue)
        result.variants.forEach { variantResult ->
            assertEquals(2, variantResult.replications.size)
            assertEquals(MetricsAggregator.aggregate(variantResult.replications), variantResult.aggregate)
        }

        val encoded = Json.encodeToString(ExperimentResult.serializer(), result)
        val root = Json.parseToJsonElement(encoded).jsonObject
        assertEquals(setOf("schemaVersion", "applicationVersion", "kslVersion", "variants"), root.keys)
        val variantsJson = root.getValue("variants").jsonArray
        assertEquals(
            setOf("id", "label", "sweepParameter", "sweepValue", "replications", "aggregate"),
            variantsJson[0].jsonObject.keys,
        )
        assertEquals(setOf("id", "label", "replications", "aggregate"), variantsJson[1].jsonObject.keys)
        assertFalse(variantsJson[1].jsonObject.containsKey("sweepParameter"))
        assertFalse(variantsJson[1].jsonObject.containsKey("sweepValue"))
        assertEquals(result, Json.decodeFromString(ExperimentResult.serializer(), encoded))
    }

    @Test
    fun `invalid document is rejected before execution`() {
        val invalid = document(
            variants = listOf(variant(id = "baseline")),
            replications = 0,
        )

        val exception = assertFailsWith<ScenarioValidationException> {
            ExperimentRunner.run(invalid)
        }

        assertTrue(exception.errors.any { it.path == "execution.replications" })
    }

    @Test
    fun `scenario cap failure rejects the whole experiment instead of returning partial results`() {
        val valid = variant(id = "valid", scenario = scenario(processing = fixed(0.0)))
        val capped = variant(
            id = "capped",
            scenario = scenario(
                arrivalRate = 1_000.0,
                processing = fixed(100.0),
                queueCapacity = 100_000,
                requestDeadlineMs = 1_000_000_000.0,
            ),
        )
        val document = document(
            variants = listOf(valid, capped),
            replications = 2,
            measurementMs = 100_000.0,
            maxRealTimeSeconds = 1L,
        )

        val exception = assertFailsWith<ExperimentExecutionException> {
            ExperimentRunner.run(document)
        }

        assertTrue(exception.message.orEmpty().contains("capped"))
    }

    @Test
    @Tag("analytic")
    fun `single service matches MM1 utilization and response time`() {
        val result = ExperimentRunner.run(
            document(
                variants = listOf(
                    variant(
                        id = "mm1",
                        scenario = scenario(
                            arrivalRate = 0.25,
                            processing = DurationDistribution(
                                kind = DistributionKind.EXPONENTIAL,
                                meanMs = 2.0,
                                stdDevMs = null,
                            ),
                            queueCapacity = 100_000,
                            requestDeadlineMs = 1_000_000_000.0,
                        ),
                    ),
                ),
                replications = 1,
                warmupMs = 10_000.0,
                measurementMs = 400_000.0,
                seed = 42L,
                maxRealTimeSeconds = 120L,
            ),
        )

        val variant = result.variants.single()
        val replication = variant.replications.single()
        val utilization = replication.services.getValue("entry").handlerUtilization
        val meanResponseMs = assertNotNull(variant.aggregate.pooledLatency.all).meanMs
        println(
            "M/M/1 analytic: arrivals=${replication.originalArrivals}, " +
                "utilization=$utilization, meanResponseMs=$meanResponseMs",
        )
        assertEquals(replication.originalArrivals, replication.successes)
        assertEquals(0, replication.failures)
        assertEquals(0.5, utilization, 0.03)
        assertEquals(4.0, meanResponseMs, 0.25)
    }

    private fun document(
        variants: List<ExperimentVariant>,
        replications: Int = 2,
        warmupMs: Double = 0.0,
        measurementMs: Double = 100.0,
        seed: Long = 42L,
        maxRealTimeSeconds: Long = 30L,
    ): ExperimentDocument = ExperimentDocument(
        schemaVersion = 1,
        execution = Execution(
            replications = replications,
            warmupMs = warmupMs,
            measurementMs = measurementMs,
            seed = seed,
            maxRealTimeSeconds = maxRealTimeSeconds,
        ),
        variants = variants,
    )

    private fun variant(
        id: String,
        label: String = id,
        scenario: Scenario = scenario(),
        sweepParameter: SweepParameter? = null,
        sweepValue: Double? = null,
    ): ExperimentVariant = ExperimentVariant(
        id = id,
        label = label,
        scenario = scenario,
        sweepParameter = sweepParameter,
        sweepValue = sweepValue,
    )

    private fun scenario(
        arrivalRate: Double = 0.25,
        processing: DurationDistribution = fixed(1.0),
        queueCapacity: Int = 1_000,
        requestDeadlineMs: Double = 10_000.0,
    ): Scenario {
        val base = TestData.simpleScenario()
        return base.copy(
            services = listOf(
                base.services.first().copy(
                    handlers = 1,
                    queueCapacity = queueCapacity,
                    processing = processing,
                    failureRate = 0.0,
                ),
            ),
            links = emptyList(),
            workload = base.workload.copy(
                arrivalRate = arrivalRate,
                requestDeadlineMs = requestDeadlineMs,
            ),
            degradation = null,
        )
    }

    private fun fixed(meanMs: Double): DurationDistribution = DurationDistribution(
        kind = DistributionKind.FIXED,
        meanMs = meanMs,
        stdDevMs = null,
    )

    private fun expectedArrivalReplications(
        seed: Long,
        arrivalRate: Double,
        measurementMs: Double,
        replications: Int,
    ): List<List<Double>> {
        val provider = RNStreamProvider().apply {
            initialSeed(SeedFactory.seedVector(seed))
        }
        val interArrival = ExponentialRV(
            mean = 1 / arrivalRate,
            streamNum = 3,
            streamProvider = provider,
        )
        return (0 until replications).map { replication ->
            if (replication > 0) {
                provider.advanceAllStreamsToNextSubStream()
            }
            val arrivals = mutableListOf<Double>()
            var timeMs = 0.0
            while (true) {
                timeMs += interArrival.value
                if (timeMs >= measurementMs) break
                arrivals += timeMs
            }
            arrivals.toList()
        }
    }
}
