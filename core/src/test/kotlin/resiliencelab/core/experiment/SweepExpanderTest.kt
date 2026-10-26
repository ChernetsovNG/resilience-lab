package resiliencelab.core.experiment

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
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class SweepExpanderTest {
    @Test
    fun `link timeout expansion preserves order metadata execution and unrelated fields`() {
        val base = threeServiceScenario()
        val execution = execution().copy(seed = 987L)
        val values = listOf(25.0, 50.0, 100.0)
        val document = sweepDocument(
            scenario = base,
            execution = execution,
            values = values,
        )
        val before = document.deepCopy()

        val expanded = SweepExpander.expand(document)

        val expectedScenarios = values.map { timeout ->
            base.copy(
                links = listOf(
                    base.links[0].copy(timeoutMs = timeout),
                    base.links[1],
                ),
            )
        }
        assertEquals(3, expanded.variants.size)
        assertEquals(1, expanded.schemaVersion)
        assertEquals(execution, expanded.execution)
        assertEquals(listOf("sweep-0", "sweep-1", "sweep-2"), expanded.variants.map { it.id })
        assertEquals(values, expanded.variants.map { it.sweepValue })
        assertEquals(
            List(values.size) { SweepParameter.LINK_TIMEOUT },
            expanded.variants.map { it.sweepParameter },
        )
        assertEquals(expectedScenarios, expanded.variants.map { it.scenario })
        assertEquals(before, document)
    }

    @Test
    fun `arrival rate expansion changes only workload rate`() {
        val base = TestData.simpleScenario()
        val values = listOf(0.2, 0.4)

        val expanded = SweepExpander.expand(
            sweepDocument(
                scenario = base,
                parameter = SweepParameter.ARRIVAL_RATE,
                linkId = null,
                values = values,
            ),
        )

        assertEquals(
            values.map { rate -> base.copy(workload = base.workload.copy(arrivalRate = rate)) },
            expanded.variants.map { it.scenario },
        )
        assertEquals(values, expanded.variants.map { it.sweepValue })
        assertEquals(
            List(values.size) { SweepParameter.ARRIVAL_RATE },
            expanded.variants.map { it.sweepParameter },
        )
    }

    @Test
    fun `max attempts expansion preserves exact integer values including upper boundary`() {
        val base = TestData.simpleScenario()
        val values = listOf(1.0, 2.0, Int.MAX_VALUE.toDouble())

        val expanded = SweepExpander.expand(
            sweepDocument(
                scenario = base,
                parameter = SweepParameter.MAX_ATTEMPTS,
                values = values,
            ),
        )

        assertEquals(listOf(1, 2, Int.MAX_VALUE), expanded.variants.map { it.scenario.links.single().maxAttempts })
        assertEquals(
            values.map { attempts ->
                base.copy(links = listOf(base.links.single().copy(maxAttempts = attempts.toInt())))
            },
            expanded.variants.map { it.scenario },
        )
        assertEquals(values, expanded.variants.map { it.sweepValue })
    }

    @Test
    fun `backoff base expansion changes baseBackoffMs and preserves retry exponent`() {
        val original = TestData.simpleScenario()
        val retry = original.links.single().retry.copy(
            kind = RetryKind.EXPONENTIAL_FULL_JITTER,
            baseBackoffMs = 4.0,
            maxBackoffMs = 40.0,
            base = 1.5,
        )
        val base = original.copy(links = listOf(original.links.single().copy(retry = retry)))
        val values = listOf(2.0, 8.0)

        val expanded = SweepExpander.expand(
            sweepDocument(
                scenario = base,
                parameter = SweepParameter.BACKOFF_BASE,
                values = values,
            ),
        )

        assertEquals(
            values.map { backoff ->
                base.copy(
                    links = listOf(
                        base.links.single().copy(retry = retry.copy(baseBackoffMs = backoff)),
                    ),
                )
            },
            expanded.variants.map { it.scenario },
        )
        expanded.variants.forEach { variant ->
            assertEquals(1.5, variant.scenario.links.single().retry.base)
            assertEquals(40.0, variant.scenario.links.single().retry.maxBackoffMs)
        }
    }

    @Test
    fun `degradation multiplier expansion changes only the matching degradation field`() {
        val original = TestData.simpleScenario()
        val degradation = DegradationSpec(
            serviceId = "backend",
            startMs = 10.0,
            endMs = 100.0,
            processingMultiplier = 2.0,
            failureRate = 0.25,
        )
        val base = original.copy(degradation = degradation)
        val values = listOf(1.25, 2.5)

        val expanded = SweepExpander.expand(
            sweepDocument(
                scenario = base,
                parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                serviceId = "backend",
                linkId = null,
                values = values,
            ),
        )

        assertEquals(
            values.map { multiplier ->
                base.copy(degradation = degradation.copy(processingMultiplier = multiplier))
            },
            expanded.variants.map { it.scenario },
        )
        expanded.variants.forEach { variant ->
            assertEquals("backend", variant.scenario.degradation?.serviceId)
            assertEquals(10.0, variant.scenario.degradation?.startMs)
            assertEquals(100.0, variant.scenario.degradation?.endMs)
            assertEquals(0.25, variant.scenario.degradation?.failureRate)
        }
    }

    @Test
    fun `missing link targets are rejected before expansion`() {
        listOf(
            SweepParameter.LINK_TIMEOUT,
            SweepParameter.MAX_ATTEMPTS,
            SweepParameter.BACKOFF_BASE,
        ).forEach { parameter ->
            val exception = assertFailsWith<ScenarioValidationException> {
                SweepExpander.expand(sweepDocument(parameter = parameter, linkId = null))
            }

            assertEquals(listOf("sweep.linkId"), exception.errors.map { it.path })
        }
    }

    @Test
    fun `degradation sweep requires base degradation rather than creating one`() {
        val exception = assertFailsWith<ScenarioValidationException> {
            SweepExpander.expand(
                sweepDocument(
                    parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                    serviceId = "backend",
                    linkId = null,
                ),
            )
        }

        assertEquals(listOf("sweep.serviceId"), exception.errors.map { it.path })
    }

    @Test
    fun `degradation sweep rejects a mismatched service rather than retargeting`() {
        val base = TestData.simpleScenario().copy(
            degradation = DegradationSpec(
                serviceId = "backend",
                startMs = 10.0,
                endMs = 100.0,
                processingMultiplier = 2.0,
                failureRate = null,
            ),
        )

        val exception = assertFailsWith<ScenarioValidationException> {
            SweepExpander.expand(
                sweepDocument(
                    scenario = base,
                    parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                    serviceId = "entry",
                    linkId = null,
                ),
            )
        }

        assertEquals(listOf("sweep.serviceId"), exception.errors.map { it.path })
    }

    @Test
    fun `invalid max attempts values are rejected without truncation or overflow`() {
        val invalidValues = listOf(
            0.0,
            -1.0,
            1.5,
            Double.NaN,
            Double.POSITIVE_INFINITY,
            Double.NEGATIVE_INFINITY,
            Int.MAX_VALUE.toDouble() + 1.0,
        )

        invalidValues.forEach { value ->
            val exception = assertFailsWith<ScenarioValidationException> {
                SweepExpander.expand(
                    sweepDocument(
                        parameter = SweepParameter.MAX_ATTEMPTS,
                        values = listOf(value),
                    ),
                )
            }
            assertEquals(listOf("sweep.values[0]"), exception.errors.map { it.path })
        }
    }

    @Test
    fun `input scenario validation happens before expansion`() {
        val base = TestData.simpleScenario()
        val invalid = base.copy(links = listOf(base.links.single().copy(timeoutMs = 0.0)))

        val exception = assertFailsWith<ScenarioValidationException> {
            SweepExpander.expand(sweepDocument(scenario = invalid))
        }

        assertEquals(listOf("baseScenario.links[0].timeoutMs"), exception.errors.map { it.path })
    }

    @Test
    fun `generated experiment validation rejects invalid expanded values`() {
        val exception = assertFailsWith<ScenarioValidationException> {
            SweepExpander.expand(sweepDocument(values = listOf(0.0)))
        }

        assertEquals(
            listOf("variants[0].scenario.links[0].timeoutMs"),
            exception.errors.map { it.path },
        )
    }

    private fun execution(): Execution = Execution(
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
    ): SweepDocument = SweepDocument(
        schemaVersion = 1,
        execution = execution,
        baseScenario = scenario,
        sweep = SweepSpec(
            parameter = parameter,
            serviceId = serviceId,
            linkId = linkId,
            values = values,
        ),
    )

    private fun threeServiceScenario(): Scenario {
        val base = TestData.simpleScenario()
        val third = base.services[1].copy(id = "third")
        val secondLink: LinkSpec = base.links.single().copy(
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

    private fun SweepDocument.deepCopy(): SweepDocument = copy(
        execution = execution.copy(),
        baseScenario = baseScenario.deepCopy(),
        sweep = sweep.copy(values = sweep.values.toList()),
    )

    private fun Scenario.deepCopy(): Scenario = copy(
        services = services.map { service -> service.copy(processing = service.processing.copy()) },
        links = links.map { link ->
            link.copy(network = link.network.copy(), retry = link.retry.copy())
        },
        workload = workload.copy(),
        degradation = degradation?.copy(),
    )
}
