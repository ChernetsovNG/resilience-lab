package resiliencelab.core.scenario

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatExceptionOfType
import kotlin.test.Test

class ScenarioValidatorTest {
    @Test
    fun `valid experiment passes validation and requireValid`() {
        val document = experimentDocument()

        assertThat(ScenarioValidator.validate(document)).isEmpty()
        ScenarioValidator.requireValid(document)
    }

    @Test
    fun `unknown entry is reported at scenario entry`() {
        val document = experimentDocument(TestData.simpleScenario().copy(entry = "missing"))

        assertExperimentPaths(listOf("variants[0].scenario.entry"), document)
    }

    @Test
    fun `empty service list is rejected`() {
        val document =
            experimentDocument(
                TestData.simpleScenario().copy(services = emptyList(), links = emptyList()),
            )

        assertExperimentPaths(listOf("variants[0].scenario.services"), document)
    }

    @Test
    fun `duplicate service ids are reported at the later declaration`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.copy(
                    services = listOf(scenario.services[0], scenario.services[0].copy()),
                    links = emptyList(),
                ),
            )

        assertExperimentPaths(listOf("variants[0].scenario.services[1].id"), document)
    }

    @Test
    fun `duplicate link ids are reported at the later declaration`() {
        val scenario = threeServiceScenario()
        val document =
            experimentDocument(
                scenario.copy(
                    links =
                        listOf(
                            scenario.links[0],
                            scenario.links[1].copy(id = scenario.links[0].id),
                        ),
                ),
            )

        assertExperimentPaths(listOf("variants[0].scenario.links[1].id"), document)
    }

    @Test
    fun `cycle is reported on the link that closes it`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.copy(
                    links =
                        scenario.links +
                            scenario.links[0].copy(
                                id = "backend-to-entry",
                                from = "backend",
                                to = "entry",
                            ),
                ),
            )

        assertExperimentPaths(listOf("variants[0].scenario.links[1].to"), document)
    }

    @Test
    fun `second outgoing link from one service is rejected`() {
        val scenario = threeServiceScenario()
        val document =
            experimentDocument(
                scenario.copy(
                    links =
                        listOf(
                            scenario.links[0],
                            scenario.links[1].copy(from = "entry"),
                        ),
                ),
            )

        assertExperimentPaths(listOf("variants[0].scenario.links[1].from"), document)
    }

    @Test
    fun `service outside the entry chain is rejected`() {
        val scenario = threeServiceScenario()
        val document = experimentDocument(scenario.copy(links = listOf(scenario.links[0])))

        assertExperimentPaths(listOf("variants[0].scenario.services[2].id"), document)
    }

    @Test
    fun `unknown link endpoints are reported at their fields`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.copy(
                    links = listOf(scenario.links[0].copy(from = "missing-from", to = "missing-to")),
                ),
            )

        val paths = ScenarioValidator.validate(document).map { it.path }
        assertThat(paths).describedAs(paths.toString()).contains("variants[0].scenario.links[0].from")
        assertThat(paths).describedAs(paths.toString()).contains("variants[0].scenario.links[0].to")
    }

    @Test
    fun `unknown endpoints do not hide an independent cycle`() {
        val scenario = TestData.simpleScenario()
        val malformed =
            scenario.links[0].copy(
                id = "malformed",
                from = "missing-from",
                to = "missing-to",
            )
        val document =
            experimentDocument(
                scenario.copy(
                    links =
                        listOf(
                            scenario.links[0],
                            scenario.links[0].copy(
                                id = "backend-to-entry",
                                from = "backend",
                                to = "entry",
                            ),
                            malformed,
                        ),
                ),
            )

        assertExperimentPaths(
            listOf(
                "variants[0].scenario.links[1].to",
                "variants[0].scenario.links[2].from",
                "variants[0].scenario.links[2].to",
            ),
            document,
        )
    }

    @Test
    fun `unknown endpoints do not hide an independent excess outgoing link`() {
        val scenario = threeServiceScenario()
        val malformed =
            scenario.links[0].copy(
                id = "malformed",
                from = "missing-from",
                to = "missing-to",
            )
        val document =
            experimentDocument(
                scenario.copy(
                    links =
                        listOf(
                            scenario.links[0],
                            scenario.links[1].copy(from = "entry"),
                            malformed,
                        ),
                ),
            )

        assertExperimentPaths(
            listOf(
                "variants[0].scenario.links[1].from",
                "variants[0].scenario.links[2].from",
                "variants[0].scenario.links[2].to",
            ),
            document,
        )
    }

    @Test
    fun `unknown endpoints do not hide an independent disconnected segment`() {
        val scenario = threeServiceScenario()
        val malformed =
            scenario.links[0].copy(
                id = "malformed",
                from = "missing-from",
                to = "missing-to",
            )
        val document =
            experimentDocument(
                scenario.copy(links = listOf(scenario.links[0], malformed)),
            )

        assertExperimentPaths(
            listOf(
                "variants[0].scenario.services[2].id",
                "variants[0].scenario.links[1].from",
                "variants[0].scenario.links[1].to",
            ),
            document,
        )
    }

    @Test
    fun `zero handlers are rejected at the service field`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.withService(1, scenario.services[1].copy(handlers = 0)),
            )

        assertExperimentPaths(listOf("variants[0].scenario.services[1].handlers"), document)
    }

    @Test
    fun `negative queue capacity is rejected at the service field`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.withService(1, scenario.services[1].copy(queueCapacity = -1)),
            )

        assertExperimentPaths(listOf("variants[0].scenario.services[1].queueCapacity"), document)
    }

    @Test
    fun `nonpositive link timeout is rejected`() {
        val scenario = TestData.simpleScenario()

        listOf(0.0, -1.0).forEach { timeout ->
            val document = experimentDocument(scenario.withLink(0, scenario.links[0].copy(timeoutMs = timeout)))
            assertExperimentPaths(listOf("variants[0].scenario.links[0].timeoutMs"), document)
        }
    }

    @Test
    fun `zero max attempts is rejected`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.withLink(0, scenario.links[0].copy(maxAttempts = 0)),
            )

        assertExperimentPaths(listOf("variants[0].scenario.links[0].maxAttempts"), document)
    }

    @Test
    fun `negative retry backoff values are rejected`() {
        val scenario = TestData.simpleScenario()
        val retry = scenario.links[0].retry.copy(baseBackoffMs = -1.0, maxBackoffMs = -2.0)
        val document =
            experimentDocument(
                scenario.withLink(0, scenario.links[0].copy(retry = retry)),
            )

        assertExperimentPaths(
            listOf(
                "variants[0].scenario.links[0].retry.baseBackoffMs",
                "variants[0].scenario.links[0].retry.maxBackoffMs",
            ),
            document,
        )
    }

    @Test
    fun `retry base must be positive and finite`() {
        val scenario = TestData.simpleScenario()

        listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY).forEach { base ->
            val retry = scenario.links[0].retry.copy(base = base)
            val document =
                experimentDocument(
                    scenario.withLink(0, scenario.links[0].copy(retry = retry)),
                )
            assertExperimentPaths(listOf("variants[0].scenario.links[0].retry.base"), document)
        }
    }

    @Test
    fun `nonpositive arrival rate is rejected`() {
        val scenario = TestData.simpleScenario()

        listOf(0.0, -1.0).forEach { arrivalRate ->
            val document =
                experimentDocument(
                    scenario.copy(workload = scenario.workload.copy(arrivalRate = arrivalRate)),
                )
            assertExperimentPaths(listOf("variants[0].scenario.workload.arrivalRate"), document)
        }
    }

    @Test
    fun `nonpositive request deadline is rejected`() {
        val scenario = TestData.simpleScenario()

        listOf(0.0, -1.0).forEach { deadline ->
            val document =
                experimentDocument(
                    scenario.copy(workload = scenario.workload.copy(requestDeadlineMs = deadline)),
                )
            assertExperimentPaths(listOf("variants[0].scenario.workload.requestDeadlineMs"), document)
        }
    }

    @Test
    fun `failure rates outside the unit interval are rejected`() {
        val scenario = TestData.simpleScenario()

        listOf(-0.01, 1.01).forEach { failureRate ->
            val document =
                experimentDocument(
                    scenario.withService(1, scenario.services[1].copy(failureRate = failureRate)),
                )
            assertExperimentPaths(listOf("variants[0].scenario.services[1].failureRate"), document)
        }
    }

    @Test
    fun `fixed distributions and probability boundaries are valid`() {
        val scenario = TestData.simpleScenario()
        val zeroFixed = scenario.services[0].processing.copy(meanMs = 0.0)
        val document =
            experimentDocument(
                scenario.copy(
                    services =
                        listOf(
                            scenario.services[0].copy(processing = zeroFixed, failureRate = 0.0, queueCapacity = 0),
                            scenario.services[1].copy(failureRate = 1.0),
                        ),
                ),
            )

        assertThat(ScenarioValidator.validate(document)).isEmpty()
    }

    @Test
    fun `exponential distribution requires a positive mean`() {
        val scenario = TestData.simpleScenario()

        listOf(0.0, -1.0).forEach { mean ->
            val processing = DurationDistribution(DistributionKind.EXPONENTIAL, mean, null)
            val document =
                experimentDocument(
                    scenario.withService(1, scenario.services[1].copy(processing = processing)),
                )
            assertExperimentPaths(listOf("variants[0].scenario.services[1].processing.meanMs"), document)
        }
    }

    @Test
    fun `lognormal distribution requires a positive mean`() {
        val scenario = TestData.simpleScenario()
        val processing = DurationDistribution(DistributionKind.LOGNORMAL, 0.0, 1.0)
        val document =
            experimentDocument(
                scenario.withService(1, scenario.services[1].copy(processing = processing)),
            )

        assertExperimentPaths(listOf("variants[0].scenario.services[1].processing.meanMs"), document)
    }

    @Test
    fun `lognormal distribution requires a positive standard deviation`() {
        val scenario = TestData.simpleScenario()

        listOf(null, 0.0, -1.0).forEach { stdDev ->
            val processing = DurationDistribution(DistributionKind.LOGNORMAL, 1.0, stdDev)
            val document =
                experimentDocument(
                    scenario.withService(1, scenario.services[1].copy(processing = processing)),
                )
            assertExperimentPaths(listOf("variants[0].scenario.services[1].processing.stdDevMs"), document)
        }
    }

    @Test
    fun `network distribution is validated with its full field path`() {
        val scenario = TestData.simpleScenario()
        val network = DurationDistribution(DistributionKind.LOGNORMAL, 1.0, 0.0)
        val document =
            experimentDocument(
                scenario.withLink(0, scenario.links[0].copy(network = network)),
            )

        assertExperimentPaths(listOf("variants[0].scenario.links[0].network.stdDevMs"), document)
    }

    @Test
    fun `degradation end must be after its start`() {
        val scenario = TestData.simpleScenario()

        listOf(10.0 to 10.0, 11.0 to 10.0).forEach { (start, end) ->
            val document =
                experimentDocument(
                    scenario.copy(
                        degradation =
                            DegradationSpec(
                                serviceId = "backend",
                                startMs = start,
                                endMs = end,
                                processingMultiplier = 2.0,
                                failureRate = null,
                            ),
                    ),
                )
            assertExperimentPaths(listOf("variants[0].scenario.degradation.endMs"), document)
        }
    }

    @Test
    fun `degradation must target an existing service`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.copy(
                    degradation =
                        DegradationSpec(
                            serviceId = "missing",
                            startMs = 0.0,
                            endMs = 10.0,
                            processingMultiplier = 2.0,
                            failureRate = 0.5,
                        ),
                ),
            )

        assertExperimentPaths(listOf("variants[0].scenario.degradation.serviceId"), document)
    }

    @Test
    fun `degradation failure rate must be within the unit interval`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.copy(
                    degradation =
                        DegradationSpec(
                            serviceId = "backend",
                            startMs = 0.0,
                            endMs = 10.0,
                            processingMultiplier = 2.0,
                            failureRate = 2.0,
                        ),
                ),
            )

        assertExperimentPaths(listOf("variants[0].scenario.degradation.failureRate"), document)
    }

    @Test
    fun `zero replications are rejected`() {
        val document = experimentDocument(execution = execution().copy(replications = 0))

        assertExperimentPaths(listOf("execution.replications"), document)
    }

    @Test
    fun `negative warmup is rejected`() {
        val document = experimentDocument(execution = execution().copy(warmupMs = -1.0))

        assertExperimentPaths(listOf("execution.warmupMs"), document)
    }

    @Test
    fun `nonpositive measurement duration is rejected`() {
        val document = experimentDocument(execution = execution().copy(measurementMs = 0.0))

        assertExperimentPaths(listOf("execution.measurementMs"), document)
    }

    @Test
    fun `nonpositive real time cap is rejected`() {
        val document = experimentDocument(execution = execution().copy(maxRealTimeSeconds = 0L))

        assertExperimentPaths(listOf("execution.maxRealTimeSeconds"), document)
    }

    @Test
    fun `all nonfinite numeric fields are returned with independent paths`() {
        val scenario = TestData.simpleScenario()
        val processing =
            scenario.services[0].processing.copy(
                meanMs = Double.NaN,
                stdDevMs = Double.POSITIVE_INFINITY,
            )
        val network =
            scenario.links[0].network.copy(
                meanMs = Double.NaN,
                stdDevMs = Double.NEGATIVE_INFINITY,
            )
        val document =
            experimentDocument(
                scenario =
                    scenario.copy(
                        services =
                            listOf(
                                scenario.services[0].copy(processing = processing, failureRate = Double.NaN),
                                scenario.services[1],
                            ),
                        links =
                            listOf(
                                scenario.links[0].copy(
                                    network = network,
                                    timeoutMs = Double.POSITIVE_INFINITY,
                                    retry =
                                        scenario.links[0].retry.copy(
                                            baseBackoffMs = Double.NaN,
                                            maxBackoffMs = Double.POSITIVE_INFINITY,
                                            base = Double.NaN,
                                        ),
                                ),
                            ),
                        workload =
                            WorkloadSpec(
                                arrivalRate = Double.NaN,
                                requestDeadlineMs = Double.NEGATIVE_INFINITY,
                            ),
                        degradation =
                            DegradationSpec(
                                serviceId = "backend",
                                startMs = Double.NaN,
                                endMs = Double.POSITIVE_INFINITY,
                                processingMultiplier = Double.NaN,
                                failureRate = Double.NEGATIVE_INFINITY,
                            ),
                    ),
                execution =
                    execution().copy(
                        warmupMs = Double.NaN,
                        measurementMs = Double.POSITIVE_INFINITY,
                    ),
            ).let { document ->
                document.copy(
                    variants = listOf(document.variants[0].copy(sweepValue = Double.NaN)),
                )
            }

        assertExperimentPaths(
            listOf(
                "execution.warmupMs",
                "execution.measurementMs",
                "variants[0].sweepValue",
                "variants[0].scenario.services[0].processing.meanMs",
                "variants[0].scenario.services[0].processing.stdDevMs",
                "variants[0].scenario.services[0].failureRate",
                "variants[0].scenario.links[0].network.meanMs",
                "variants[0].scenario.links[0].network.stdDevMs",
                "variants[0].scenario.links[0].timeoutMs",
                "variants[0].scenario.links[0].retry.baseBackoffMs",
                "variants[0].scenario.links[0].retry.maxBackoffMs",
                "variants[0].scenario.links[0].retry.base",
                "variants[0].scenario.workload.arrivalRate",
                "variants[0].scenario.workload.requestDeadlineMs",
                "variants[0].scenario.degradation.startMs",
                "variants[0].scenario.degradation.endMs",
                "variants[0].scenario.degradation.processingMultiplier",
                "variants[0].scenario.degradation.failureRate",
            ),
            document,
        )
    }

    @Test
    fun `validation accumulates errors from every variant`() {
        val first = experimentDocument().variants[0]
        val secondScenario =
            TestData.simpleScenario().withService(
                1,
                TestData.simpleScenario().services[1].copy(handlers = 0),
            )
        val document =
            experimentDocument(
                TestData.simpleScenario().withService(
                    1,
                    TestData.simpleScenario().services[1].copy(queueCapacity = -1),
                ),
            ).copy(
                variants =
                    listOf(
                        first.copy(
                            scenario =
                                TestData.simpleScenario().withService(
                                    1,
                                    TestData.simpleScenario().services[1].copy(queueCapacity = -1),
                                ),
                        ),
                        first.copy(id = "second", scenario = secondScenario),
                    ),
            )

        assertExperimentPaths(
            listOf(
                "variants[0].scenario.services[1].queueCapacity",
                "variants[1].scenario.services[1].handlers",
            ),
            document,
        )
    }

    @Test
    fun `requireValid throws all experiment errors`() {
        val scenario = TestData.simpleScenario()
        val document =
            experimentDocument(
                scenario.withLink(0, scenario.links[0].copy(maxAttempts = 0)),
                execution().copy(replications = 0),
            )

        assertThatExceptionOfType(ScenarioValidationException::class.java)
            .isThrownBy { ScenarioValidator.requireValid(document) }
            .satisfies({ exception ->
                assertThat(exception.errors.map { it.path }.sorted()).containsExactly(
                    "execution.replications",
                    "variants[0].scenario.links[0].maxAttempts",
                )
            })
    }

    @Test
    fun `valid sweep passes validation and requireValid`() {
        val document = sweepDocument()

        assertThat(ScenarioValidator.validate(document)).isEmpty()
        ScenarioValidator.requireValid(document)
    }

    @Test
    fun `arrival rate sweep needs no service or link target`() {
        val document =
            sweepDocument(
                parameter = SweepParameter.ARRIVAL_RATE,
                serviceId = null,
                linkId = null,
                values = listOf(0.1, 0.2),
            )

        assertThat(ScenarioValidator.validate(document)).isEmpty()
    }

    @Test
    fun `link sweep parameters reject a missing link target`() {
        listOf(
            SweepParameter.LINK_TIMEOUT,
            SweepParameter.MAX_ATTEMPTS,
            SweepParameter.BACKOFF_BASE,
        ).forEach { parameter ->
            val document = sweepDocument(parameter = parameter, linkId = "missing")
            assertSweepPaths(listOf("sweep.linkId"), document)
        }
    }

    @Test
    fun `link sweep parameter requires a link target`() {
        val document = sweepDocument(linkId = null)

        assertSweepPaths(listOf("sweep.linkId"), document)
    }

    @Test
    fun `degradation sweep rejects a missing service target`() {
        val document =
            sweepDocument(
                parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                serviceId = "missing",
                linkId = null,
            )

        assertSweepPaths(listOf("sweep.serviceId"), document)
    }

    @Test
    fun `degradation sweep requires a service target`() {
        val document =
            sweepDocument(
                parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                serviceId = null,
                linkId = null,
            )

        assertSweepPaths(listOf("sweep.serviceId"), document)
    }

    @Test
    fun `max attempts sweep values must be exact integers within Int range`() {
        val values =
            listOf(
                0.0,
                -1.0,
                1.5,
                Double.NaN,
                Double.POSITIVE_INFINITY,
                Double.NEGATIVE_INFINITY,
                Int.MAX_VALUE.toDouble() + 1.0,
            )
        val document =
            sweepDocument(
                parameter = SweepParameter.MAX_ATTEMPTS,
                values = values,
            )

        assertSweepPaths(values.indices.map { "sweep.values[$it]" }, document)
        assertThat(
            ScenarioValidator.validate(
                sweepDocument(
                    parameter = SweepParameter.MAX_ATTEMPTS,
                    values = listOf(1.0, Int.MAX_VALUE.toDouble()),
                ),
            ),
        ).isEmpty()
    }

    @Test
    fun `degradation sweep requires an existing base degradation`() {
        val document =
            sweepDocument(
                parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                serviceId = "backend",
                linkId = null,
            )

        assertSweepPaths(listOf("sweep.serviceId"), document)
    }

    @Test
    fun `degradation sweep service must match the base degradation service`() {
        val scenario =
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
        val document =
            sweepDocument(
                scenario = scenario,
                parameter = SweepParameter.DEGRADATION_MULTIPLIER,
                serviceId = "entry",
                linkId = null,
            )

        assertSweepPaths(listOf("sweep.serviceId"), document)
    }

    @Test
    fun `sweep values must not be empty`() {
        val document = sweepDocument(values = emptyList())

        assertSweepPaths(listOf("sweep.values"), document)
    }

    @Test
    fun `every sweep value must be finite`() {
        val document = sweepDocument(values = listOf(1.0, Double.NaN, Double.POSITIVE_INFINITY))

        assertSweepPaths(listOf("sweep.values[1]", "sweep.values[2]"), document)
    }

    @Test
    fun `sweep validation includes common execution and scenario errors`() {
        val scenario = TestData.simpleScenario()
        val document =
            sweepDocument(
                scenario = scenario.withService(1, scenario.services[1].copy(handlers = 0)),
                execution = execution().copy(replications = 0),
            )

        assertSweepPaths(
            listOf("execution.replications", "baseScenario.services[1].handlers"),
            document,
        )
    }

    @Test
    fun `requireValid throws sweep errors`() {
        val document = sweepDocument(values = emptyList())

        assertThatExceptionOfType(ScenarioValidationException::class.java)
            .isThrownBy { ScenarioValidator.requireValid(document) }
            .satisfies({ exception ->
                assertThat(exception.errors.map { it.path }).containsExactly("sweep.values")
            })
    }

    private fun execution(): Execution =
        Execution(
            replications = 1,
            warmupMs = 0.0,
            measurementMs = 1_000.0,
            seed = 42L,
            maxRealTimeSeconds = 60L,
        )

    private fun experimentDocument(
        scenario: Scenario = TestData.simpleScenario(),
        execution: Execution = execution(),
    ): ExperimentDocument =
        ExperimentDocument(
            schemaVersion = 1,
            execution = execution,
            variants =
                listOf(
                    ExperimentVariant(
                        id = "baseline",
                        label = "Baseline",
                        scenario = scenario,
                        sweepParameter = SweepParameter.LINK_TIMEOUT,
                        sweepValue = 50.0,
                    ),
                ),
        )

    private fun sweepDocument(
        scenario: Scenario = TestData.simpleScenario(),
        execution: Execution = execution(),
        parameter: SweepParameter = SweepParameter.LINK_TIMEOUT,
        serviceId: String? = null,
        linkId: String? = "entry-to-backend",
        values: List<Double> = listOf(25.0, 50.0),
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
        val scenario = TestData.simpleScenario()
        val third = scenario.services[1].copy(id = "third")
        val secondLink =
            scenario.links[0].copy(
                id = "backend-to-third",
                from = "backend",
                to = "third",
            )
        return scenario.copy(
            services = scenario.services + third,
            links = scenario.links + secondLink,
        )
    }

    private fun Scenario.withService(
        index: Int,
        service: ServiceSpec,
    ): Scenario = copy(services = services.toMutableList().apply { this[index] = service })

    private fun Scenario.withLink(
        index: Int,
        link: LinkSpec,
    ): Scenario = copy(links = links.toMutableList().apply { this[index] = link })

    private fun assertExperimentPaths(
        expected: List<String>,
        document: ExperimentDocument,
    ) {
        val issues = ScenarioValidator.validate(document)
        assertThat(issues.map { it.path }.sorted()).isEqualTo(expected.sorted())
        assertThat(issues).describedAs(issues.toString()).allMatch { it.message.isNotBlank() }
    }

    private fun assertSweepPaths(
        expected: List<String>,
        document: SweepDocument,
    ) {
        val issues = ScenarioValidator.validate(document)
        assertThat(issues.map { it.path }.sorted()).isEqualTo(expected.sorted())
        assertThat(issues).describedAs(issues.toString()).allMatch { it.message.isNotBlank() }
    }
}
