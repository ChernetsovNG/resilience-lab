package resiliencelab.core.experiment

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatExceptionOfType
import org.assertj.core.data.Offset.offset
import org.junit.jupiter.api.Tag
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.ExperimentDocument
import resiliencelab.core.scenario.ExperimentVariant
import resiliencelab.core.scenario.Scenario
import resiliencelab.core.scenario.ScenarioValidationException
import resiliencelab.core.scenario.SweepParameter
import resiliencelab.core.scenario.TestData
import resiliencelab.core.simulation.ExperimentExecutionException
import resiliencelab.core.simulation.SeedFactory
import kotlin.test.Test

class ExperimentRunnerTest {
    @Test
    fun `same document produces identical results`() {
        val document =
            document(
                variants =
                    listOf(
                        variant(id = "baseline", scenario = scenario(processing = fixed(1.0))),
                        variant(id = "candidate", scenario = scenario(processing = fixed(2.0))),
                    ),
            )

        val first = ExperimentRunner.run(document)
        val second = ExperimentRunner.run(document)

        assertThat(second).isEqualTo(first)
    }

    @Test
    fun `different seeds change arrival streams`() {
        val variants = listOf(variant(id = "baseline"))

        val first = ExperimentRunner.run(document(variants = variants, seed = 42L))
        val second = ExperimentRunner.run(document(variants = variants, seed = 43L))

        assertThat(
            second.variants
                .single()
                .replications
                .map { it.arrivalTimesMs },
        ).isNotEqualTo(
            first.variants
                .single()
                .replications
                .map { it.arrivalTimesMs },
        )
    }

    @Test
    fun `paired variants share arrival timestamps`() {
        val result =
            ExperimentRunner.run(
                document(
                    variants =
                        listOf(
                            variant(id = "baseline", scenario = scenario(processing = fixed(1.0))),
                            variant(id = "candidate", scenario = scenario(processing = fixed(2.0))),
                        ),
                    replications = 3,
                ),
            )
        val baseline = result.variants[0].replications
        val candidate = result.variants[1].replications

        baseline.indices.forEach { index ->
            assertThat(candidate[index].arrivalTimesMs).isEqualTo(baseline[index].arrivalTimesMs)
        }
    }

    @Test
    fun `replications use consecutive substreams in result order`() {
        val executionSeed = 42L
        val measurementMs = 100.0
        val arrivalRate = 0.25
        val result =
            ExperimentRunner.run(
                document(
                    variants =
                        listOf(
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

        val expected =
            expectedArrivalReplications(
                seed = executionSeed,
                arrivalRate = arrivalRate,
                measurementMs = measurementMs,
                replications = 3,
            )
        val actual =
            result.variants
                .single()
                .replications
                .map { it.arrivalTimesMs }
        assertThat(actual).isEqualTo(expected)
        assertThat(actual[1]).isNotEqualTo(actual[0])
    }

    @Test
    fun `result metadata ordering and serialization match the experiment contract`() {
        val result =
            ExperimentRunner.run(
                document(
                    variants =
                        listOf(
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

        assertThat(result.schemaVersion).isEqualTo(1)
        assertThat(result.applicationVersion).isEqualTo("0.1.0")
        assertThat(result.kslVersion).isEqualTo("R1.8.1")
        assertThat(result.variants.map { it.id }).containsExactly("sweep-1", "baseline")
        assertThat(result.variants.map { it.label }).containsExactly("Arrival rate 0.25", "Baseline")
        assertThat(result.variants[0].sweepParameter).isEqualTo(SweepParameter.ARRIVAL_RATE)
        assertThat(result.variants[0].sweepValue).isEqualTo(0.25)
        assertThat(result.variants[1].sweepParameter).isNull()
        assertThat(result.variants[1].sweepValue).isNull()
        result.variants.forEach { variantResult ->
            assertThat(variantResult.replications).hasSize(2)
            assertThat(variantResult.aggregate).isEqualTo(MetricsAggregator.aggregate(variantResult.replications))
        }

        val encoded = Json.encodeToString(ExperimentResult.serializer(), result)
        val root = Json.parseToJsonElement(encoded).jsonObject
        assertThat(root.keys).containsExactlyInAnyOrder("schemaVersion", "applicationVersion", "kslVersion", "variants")
        val variantsJson = root.getValue("variants").jsonArray
        assertThat(variantsJson[0].jsonObject.keys).containsExactlyInAnyOrder(
            "id",
            "label",
            "sweepParameter",
            "sweepValue",
            "replications",
            "aggregate",
        )
        assertThat(variantsJson[1].jsonObject.keys).containsExactlyInAnyOrder("id", "label", "replications", "aggregate")
        assertThat(variantsJson[1].jsonObject.containsKey("sweepParameter")).isFalse()
        assertThat(variantsJson[1].jsonObject.containsKey("sweepValue")).isFalse()
        assertThat(Json.decodeFromString(ExperimentResult.serializer(), encoded)).isEqualTo(result)
    }

    @Test
    fun `invalid document is rejected before execution`() {
        val invalid =
            document(
                variants = listOf(variant(id = "baseline")),
                replications = 0,
            )

        assertThatExceptionOfType(ScenarioValidationException::class.java)
            .isThrownBy { ExperimentRunner.run(invalid) }
            .satisfies({ exception ->
                assertThat(exception.errors).anyMatch { it.path == "execution.replications" }
            })
    }

    @Test
    fun `scenario cap failure rejects the whole experiment instead of returning partial results`() {
        val valid = variant(id = "valid", scenario = scenario(processing = fixed(0.0)))
        val capped =
            variant(
                id = "capped",
                scenario =
                    scenario(
                        arrivalRate = 1_000.0,
                        processing = fixed(100.0),
                        queueCapacity = 100_000,
                        requestDeadlineMs = 1_000_000_000.0,
                    ),
            )
        val document =
            document(
                variants = listOf(valid, capped),
                replications = 2,
                measurementMs = 100_000.0,
                maxRealTimeSeconds = 1L,
            )

        assertThatExceptionOfType(ExperimentExecutionException::class.java)
            .isThrownBy { ExperimentRunner.run(document) }
            .satisfies({ exception -> assertThat(exception.message.orEmpty()).contains("capped") })
    }

    @Test
    @Tag("analytic")
    fun `single service matches MM1 utilization and response time`() {
        val result =
            ExperimentRunner.run(
                document(
                    variants =
                        listOf(
                            variant(
                                id = "mm1",
                                scenario =
                                    scenario(
                                        arrivalRate = 0.25,
                                        processing =
                                            DurationDistribution(
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
        val pooledLatency = variant.aggregate.pooledLatency.all
        assertThat(pooledLatency).isNotNull()
        val meanResponseMs = pooledLatency!!.meanMs
        println(
            "M/M/1 analytic: arrivals=${replication.originalArrivals}, " +
                "utilization=$utilization, meanResponseMs=$meanResponseMs",
        )
        assertThat(replication.successes).isEqualTo(replication.originalArrivals)
        assertThat(replication.failures).isZero()
        assertThat(utilization).isCloseTo(0.5, offset(0.03))
        assertThat(meanResponseMs).isCloseTo(4.0, offset(0.25))
    }

    private fun document(
        variants: List<ExperimentVariant>,
        replications: Int = 2,
        warmupMs: Double = 0.0,
        measurementMs: Double = 100.0,
        seed: Long = 42L,
        maxRealTimeSeconds: Long = 30L,
    ): ExperimentDocument =
        ExperimentDocument(
            schemaVersion = 1,
            execution =
                Execution(
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
    ): ExperimentVariant =
        ExperimentVariant(
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
            services =
                listOf(
                    base.services.first().copy(
                        handlers = 1,
                        queueCapacity = queueCapacity,
                        processing = processing,
                        failureRate = 0.0,
                    ),
                ),
            links = emptyList(),
            workload =
                base.workload.copy(
                    arrivalRate = arrivalRate,
                    requestDeadlineMs = requestDeadlineMs,
                ),
            degradation = null,
        )
    }

    private fun fixed(meanMs: Double): DurationDistribution =
        DurationDistribution(
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
        val provider =
            RNStreamProvider().apply {
                initialSeed(SeedFactory.seedVector(seed))
            }
        val interArrival =
            ExponentialRV(
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
