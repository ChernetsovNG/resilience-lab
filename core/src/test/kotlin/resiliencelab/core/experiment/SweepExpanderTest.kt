package resiliencelab.core.experiment

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatExceptionOfType
import resiliencelab.core.scenario.DegradationSpec
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.LinkSpec
import resiliencelab.core.scenario.RetryKind
import resiliencelab.core.scenario.Scenario
import resiliencelab.core.scenario.ScenarioValidationException
import resiliencelab.core.scenario.SweepDocument
import resiliencelab.core.scenario.SweepParameter
import resiliencelab.core.scenario.SweepSpec
import resiliencelab.core.scenario.TestData
import kotlin.test.Test

class SweepExpanderTest {
    @Test
    fun `link timeout expansion preserves order metadata execution and unrelated fields`() {
        val base = threeServiceScenario()
        val execution = execution().copy(seed = 987L)
        val values = listOf(25.0, 50.0, 100.0)
        val document =
            sweepDocument(
                scenario = base,
                execution = execution,
                values = values,
            )
        val before = document.deepCopy()

        val expanded = SweepExpander.expand(document)

        val expectedScenarios =
            values.map { timeout ->
                base.copy(
                    links =
                        listOf(
                            base.links[0].copy(timeoutMs = timeout),
                            base.links[1],
                        ),
                )
            }
        assertThat(expanded.variants).hasSize(3)
        assertThat(expanded.schemaVersion).isEqualTo(1)
        assertThat(expanded.execution).isEqualTo(execution)
        assertThat(expanded.variants.map { it.id }).containsExactly("sweep-0", "sweep-1", "sweep-2")
        assertThat(expanded.variants.map { it.sweepValue }).containsExactly(25.0, 50.0, 100.0)
        assertThat(expanded.variants.map { it.sweepParameter })
            .containsExactly(*Array(values.size) { SweepParameter.LINK_TIMEOUT })
        assertThat(expanded.variants.map { it.scenario }).isEqualTo(expectedScenarios)
        assertThat(document).isEqualTo(before)
    }

    @Test
    fun `arrival rate expansion changes only workload rate`() {
        val base = TestData.simpleScenario()
        val values = listOf(0.2, 0.4)

        val expanded =
            SweepExpander.expand(
                sweepDocument(
                    scenario = base,
                    parameter = SweepParameter.ARRIVAL_RATE,
                    linkId = null,
                    values = values,
                ),
            )

        assertThat(expanded.variants.map { it.scenario }).isEqualTo(
            values.map { rate -> base.copy(workload = base.workload.copy(arrivalRate = rate)) },
        )
        assertThat(expanded.variants.map { it.sweepValue }).isEqualTo(values)
        assertThat(expanded.variants.map { it.sweepParameter }).isEqualTo(
            List(values.size) { SweepParameter.ARRIVAL_RATE },
        )
    }

    @Test
    fun `max attempts expansion preserves exact integer values including upper boundary`() {
        val base = TestData.simpleScenario()
        val values = listOf(1.0, 2.0, Int.MAX_VALUE.toDouble())

        val expanded =
            SweepExpander.expand(
                sweepDocument(
                    scenario = base,
                    parameter = SweepParameter.MAX_ATTEMPTS,
                    values = values,
                ),
            )

        assertThat(
            expanded.variants.map {
                it.scenario.links
                    .single()
                    .maxAttempts
            },
        ).containsExactly(1, 2, Int.MAX_VALUE)
        assertThat(expanded.variants.map { it.scenario }).isEqualTo(
            values.map { attempts ->
                base.copy(links = listOf(base.links.single().copy(maxAttempts = attempts.toInt())))
            },
        )
        assertThat(expanded.variants.map { it.sweepValue }).isEqualTo(values)
    }

    @Test
    fun `backoff base expansion changes baseBackoffMs and preserves retry exponent`() {
        val original = TestData.simpleScenario()
        val retry =
            original.links.single().retry.copy(
                kind = RetryKind.EXPONENTIAL_FULL_JITTER,
                baseBackoffMs = 4.0,
                maxBackoffMs = 40.0,
                base = 1.5,
            )
        val base = original.copy(links = listOf(original.links.single().copy(retry = retry)))
        val values = listOf(2.0, 8.0)

        val expanded =
            SweepExpander.expand(
                sweepDocument(
                    scenario = base,
                    parameter = SweepParameter.BACKOFF_BASE,
                    values = values,
                ),
            )

        assertThat(expanded.variants.map { it.scenario }).isEqualTo(
            values.map { backoff ->
                base.copy(
                    links =
                        listOf(
                            base.links.single().copy(retry = retry.copy(baseBackoffMs = backoff)),
                        ),
                )
            },
        )
        expanded.variants.forEach { variant ->
            assertThat(
                variant.scenario.links
                    .single()
                    .retry.base,
            ).isEqualTo(1.5)
            assertThat(
                variant.scenario.links
                    .single()
                    .retry.maxBackoffMs,
            ).isEqualTo(40.0)
        }
    }

    @Test
    fun `degradation multiplier expansion changes only the matching degradation field`() {
        val original = TestData.simpleScenario()
        val degradation =
            DegradationSpec(
                serviceId = "backend",
                startMs = 10.0,
                endMs = 100.0,
                processingMultiplier = 2.0,
                failureRate = 0.25,
            )
        val base = original.copy(degradation = degradation)
        val values = listOf(1.25, 2.5)

        val expanded =
            SweepExpander.expand(
                sweepDocument(
                    scenario = base,
                    parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                    serviceId = "backend",
                    linkId = null,
                    values = values,
                ),
            )

        assertThat(expanded.variants.map { it.scenario }).isEqualTo(
            values.map { multiplier ->
                base.copy(degradation = degradation.copy(processingMultiplier = multiplier))
            },
        )
        expanded.variants.forEach { variant ->
            assertThat(variant.scenario.degradation?.serviceId).isEqualTo("backend")
            assertThat(variant.scenario.degradation?.startMs).isEqualTo(10.0)
            assertThat(variant.scenario.degradation?.endMs).isEqualTo(100.0)
            assertThat(variant.scenario.degradation?.failureRate).isEqualTo(0.25)
        }
    }

    @Test
    fun `missing link targets are rejected before expansion`() {
        listOf(
            SweepParameter.LINK_TIMEOUT,
            SweepParameter.MAX_ATTEMPTS,
            SweepParameter.BACKOFF_BASE,
        ).forEach { parameter ->
            assertThatExceptionOfType(ScenarioValidationException::class.java)
                .isThrownBy { SweepExpander.expand(sweepDocument(parameter = parameter, linkId = null)) }
                .satisfies({ exception ->
                    assertThat(exception.errors.map { it.path }).containsExactly("sweep.linkId")
                })
        }
    }

    @Test
    fun `degradation sweep requires base degradation rather than creating one`() {
        assertThatExceptionOfType(ScenarioValidationException::class.java)
            .isThrownBy {
                SweepExpander.expand(
                    sweepDocument(
                        parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                        serviceId = "backend",
                        linkId = null,
                    ),
                )
            }.satisfies({ exception ->
                assertThat(exception.errors.map { it.path }).containsExactly("sweep.serviceId")
            })
    }

    @Test
    fun `degradation sweep rejects a mismatched service rather than retargeting`() {
        val base =
            TestData.simpleScenario().copy(
                degradation =
                    DegradationSpec(
                        serviceId = "backend",
                        startMs = 10.0,
                        endMs = 100.0,
                        processingMultiplier = 2.0,
                        failureRate = null,
                    ),
            )

        assertThatExceptionOfType(ScenarioValidationException::class.java)
            .isThrownBy {
                SweepExpander.expand(
                    sweepDocument(
                        scenario = base,
                        parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                        serviceId = "entry",
                        linkId = null,
                    ),
                )
            }.satisfies({ exception ->
                assertThat(exception.errors.map { it.path }).containsExactly("sweep.serviceId")
            })
    }

    @Test
    fun `invalid max attempts values are rejected without truncation or overflow`() {
        val invalidValues =
            listOf(
                0.0,
                -1.0,
                1.5,
                Double.NaN,
                Double.POSITIVE_INFINITY,
                Double.NEGATIVE_INFINITY,
                Int.MAX_VALUE.toDouble() + 1.0,
            )

        invalidValues.forEach { value ->
            assertThatExceptionOfType(ScenarioValidationException::class.java)
                .isThrownBy {
                    SweepExpander.expand(
                        sweepDocument(
                            parameter = SweepParameter.MAX_ATTEMPTS,
                            values = listOf(value),
                        ),
                    )
                }.satisfies({ exception ->
                    assertThat(exception.errors.map { it.path }).containsExactly("sweep.values[0]")
                })
        }
    }

    @Test
    fun `input scenario validation happens before expansion`() {
        val base = TestData.simpleScenario()
        val invalid = base.copy(links = listOf(base.links.single().copy(timeoutMs = 0.0)))

        assertThatExceptionOfType(ScenarioValidationException::class.java)
            .isThrownBy { SweepExpander.expand(sweepDocument(scenario = invalid)) }
            .satisfies({ exception ->
                assertThat(exception.errors.map { it.path }).containsExactly("baseScenario.links[0].timeoutMs")
            })
    }

    @Test
    fun `generated experiment validation rejects invalid expanded values`() {
        assertThatExceptionOfType(ScenarioValidationException::class.java)
            .isThrownBy { SweepExpander.expand(sweepDocument(values = listOf(0.0))) }
            .satisfies({ exception ->
                assertThat(exception.errors.map { it.path })
                    .containsExactly("variants[0].scenario.links[0].timeoutMs")
            })
    }

    private fun execution(): Execution =
        Execution(
            replications = 2,
            warmupMs = 5.0,
            measurementMs = 1_000.0,
            seed = 42L,
            maxRealTimeSeconds = 60L,
        )

    private fun sweepDocument(
        scenario: Scenario = TestData.simpleScenario(),
        execution: Execution = execution(),
        parameter: SweepParameter = SweepParameter.LINK_TIMEOUT,
        serviceId: String? = null,
        linkId: String? = "entry-to-backend",
        values: List<Double> = listOf(25.0, 50.0, 100.0),
    ): SweepDocument =
        SweepDocument(
            schemaVersion = 1,
            execution = execution,
            baseScenario = scenario,
            sweep =
                SweepSpec(
                    parameter = parameter,
                    serviceId = serviceId,
                    linkId = linkId,
                    values = values,
                ),
        )

    private fun threeServiceScenario(): Scenario {
        val base = TestData.simpleScenario()
        val third = base.services[1].copy(id = "third")
        val secondLink: LinkSpec =
            base.links.single().copy(
                id = "backend-to-third",
                from = "backend",
                to = "third",
                timeoutMs = 80.0,
            )
        return base.copy(
            services = base.services + third,
            links = base.links + secondLink,
        )
    }

    private fun SweepDocument.deepCopy(): SweepDocument =
        copy(
            execution = execution.copy(),
            baseScenario = baseScenario.deepCopy(),
            sweep = sweep.copy(values = sweep.values.toList()),
        )

    private fun Scenario.deepCopy(): Scenario =
        copy(
            services = services.map { service -> service.copy(processing = service.processing.copy()) },
            links =
                links.map { link ->
                    link.copy(network = link.network.copy(), retry = link.retry.copy())
                },
            workload = workload.copy(),
            degradation = degradation?.copy(),
        )
}
