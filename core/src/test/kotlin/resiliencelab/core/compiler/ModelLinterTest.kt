package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Assertions.assertTimeoutPreemptively
import resiliencelab.core.document.GridAxis
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.CircuitBreakerConfig
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FallbackConfig
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import java.time.Duration
import kotlin.test.Test

class ModelLinterTest {
    private fun variant(
        id: String,
        label: String,
        chain: GraphIr,
    ) = CompiledVariant(id, label, listOf(CompiledPoint("p0", emptyMap(), chain)))

    private val linter = ModelLinter(timeoutBudgetTolerance = 0.0)
    private val noBackoff = Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0)
    private val chain =
        GraphIr(
            ClientNode("client", 0.001, 1_000.0, Origin("m.model.json", "/blocks/client")),
            "a",
            listOf(service("a", 1.0), service("b", 2.0), service("c", 8.0)),
            listOf(call("a-b", "a", "b", 100.0, 1, 1), call("b-c", "b", "c", 20.0, 1, 2)),
            emptyList(),
            RunSettings(5, 0.0, 1.0, 1L, 30L),
        )

    @Test
    fun `retries without jitter warn only above one attempt for none and fixed backoffs`() {
        listOf(
            Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0) to "none",
            Backoff(BackoffKind.FIXED, 500.125, 500.125, 2.0) to "fixed",
            Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 25.0, 1_000.0, 2.0) to "exponential-full-jitter",
        ).forEach { (backoff, kind) ->
            listOf(1, 2, 3).forEach { attempts ->
                val changed = chain.copy(calls = listOf(chain.calls[0].copy(attempts = attempts, backoff = backoff), chain.calls[1]))
                val findings = warnings(changed, "LINT_RETRY_NO_JITTER")

                assertThat(findings)
                    .describedAs("$kind, $attempts attempts")
                    .hasSize(if (attempts > 1 && kind != "exponential-full-jitter") 1 else 0)
                findings.forEach { warning ->
                    assertThat(warning.severity).isEqualTo(Severity.WARNING)
                    assertThat(warning.document).isEqualTo("m.model.json")
                    assertThat(warning.pointer).isEqualTo("/connections/1/params/backoff/kind")
                    assertThat(warning.path).isEqualTo("a-b")
                    assertThat(
                        warning.message,
                    ).contains("'a-b'", "$attempts attempts", "'$kind'", "threshold of 1", "exponential-full-jitter")
                    assertThat(warning.args).containsAllEntriesOf(
                        mapOf(
                            "connection" to JsonPrimitive("a-b"),
                            "attempts" to JsonPrimitive(attempts),
                            "backoff" to JsonPrimitive(kind),
                            "threshold" to JsonPrimitive(1),
                        ),
                    )
                }
            }
        }
    }

    @Test
    fun `jitter warning threshold is a positive attempt count with equality allowed`() {
        val configurable = ModelLinter(retryNoJitterThreshold = 2)
        val atThreshold = chain.copy(calls = listOf(chain.calls[0].copy(attempts = 2), chain.calls[1]))
        val aboveThreshold = atThreshold.copy(calls = listOf(atThreshold.calls[0].copy(attempts = 3), atThreshold.calls[1]))

        assertThat(configurable.lint(experiment(atThreshold)).filter { it.code == "LINT_RETRY_NO_JITTER" }).isEmpty()
        val warning = configurable.lint(experiment(aboveThreshold)).single { it.code == "LINT_RETRY_NO_JITTER" }
        assertThat(warning.message).contains("3 attempts", "threshold of 2")
        assertThat(warning.args).containsEntry("threshold", JsonPrimitive(2))
        listOf(0, -1).forEach { threshold ->
            assertThatThrownBy { ModelLinter(retryNoJitterThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `jitter warning follows request type paths and ignores retry budgets`() {
        val changed =
            chain.copy(
                clients =
                    listOf(
                        chain.client.copy(
                            classes = mapOf("checkout" to LoadProfile.constant(0.001), "lookup" to LoadProfile.constant(0.001)),
                        ),
                        chain.client.copy(pathSegments = listOf("second"), classes = mapOf("checkout" to LoadProfile.constant(0.001))),
                    ),
                services =
                    listOf(
                        chain.services[0].copy(scenario = listOf(ServiceStep.Process(), ServiceStep.Call("a-b", setOf("checkout")))),
                        chain.services[1].copy(scenario = listOf(ServiceStep.Process(), ServiceStep.Call("b-c", setOf("unused")))),
                        chain.services[2],
                    ),
                calls = chain.calls.map { it.copy(attempts = 3, retryBudget = RetryBudgetConfig(0.1, 0.01, 1_000.0)) },
            )

        assertThat(warnings(changed, "LINT_RETRY_NO_JITTER").map { it.path }).containsExactly("a-b")
    }

    @Test
    fun `timeout warns at the client deadline including fractional equality`() {
        listOf(100.124 to 0, 100.125 to 1, 100.25 to 1).forEach { (timeout, count) ->
            val changed =
                chain.copy(
                    clients = listOf(chain.client.copy(deadlineMs = 100.125)),
                    calls = listOf(chain.calls[0].copy(timeoutMs = timeout), chain.calls[1]),
                )
            val findings = warnings(changed, "LINT_TIMEOUT_UNREACHABLE")

            assertThat(findings).describedAs("timeout $timeout").hasSize(count)
            findings.forEach { warning ->
                assertThat(warning.severity).isEqualTo(Severity.WARNING)
                assertThat(warning.document).isEqualTo("m.model.json")
                assertThat(warning.pointer).isEqualTo("/connections/1/params/timeout")
                assertThat(warning.path).isEqualTo("a-b")
                assertThat(warning.message).contains("'a-b'", "'client': 100.125", "1 × deadline")
                assertThat(warning.args)
                    .containsEntry("connection", JsonPrimitive("a-b"))
                    .containsEntry("timeoutMs", JsonPrimitive(timeout.toString()))
                    .containsEntry("clientDeadlines", JsonPrimitive("'client': 100.125"))
                    .containsEntry("threshold", JsonPrimitive("1"))
            }
        }
    }

    @Test
    fun `unreachable timeout threshold can require a larger multiple of the deadline`() {
        val changed = chain.copy(clients = listOf(chain.client.copy(deadlineMs = 50.0)))
        val configurable = ModelLinter(timeoutUnreachableThreshold = 2.0)

        assertThat(configurable.lint(experiment(changed)).filter { it.code == "LINT_TIMEOUT_UNREACHABLE" }).hasSize(1)
        assertThat(
            configurable
                .lint(experiment(changed.copy(calls = listOf(chain.calls[0].copy(timeoutMs = 99.999), chain.calls[1]))))
                .filter { it.code == "LINT_TIMEOUT_UNREACHABLE" },
        ).isEmpty()
        assertThat(configurable.lint(experiment(changed)).single { it.code == "LINT_TIMEOUT_UNREACHABLE" }.args)
            .containsEntry("threshold", JsonPrimitive("2"))
        val fractional = ModelLinter(timeoutUnreachableThreshold = 1.000125).lint(experiment(changed))
        assertThat(fractional.single { it.code == "LINT_TIMEOUT_UNREACHABLE" }.args)
            .containsEntry("threshold", JsonPrimitive("1.000125"))
        listOf(0.0, 0.5, Double.NaN, Double.POSITIVE_INFINITY).forEach { threshold ->
            assertThatThrownBy { ModelLinter(timeoutUnreachableThreshold = threshold) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `a larger inner timeout below the client deadline only warns about the outer budget`() {
        val changed = chain.copy(calls = listOf(chain.calls[0], chain.calls[1].copy(timeoutMs = 200.0)))

        val findings = linter.lint(experiment(changed))

        assertThat(findings.map { it.code }).containsExactly("LINT_TIMEOUT_BUDGET")
        assertThat(findings.single().path).isEqualTo("a-b")
    }

    @Test
    fun `unreachable timeout lists only affected clients once across their request types`() {
        val changed =
            chain.copy(
                clients =
                    listOf(
                        chain.client.copy(
                            classes = mapOf("checkout" to LoadProfile.constant(0.001), "lookup" to LoadProfile.constant(0.001)),
                            deadlineMs = 100.0,
                        ),
                        chain.client.copy(
                            pathSegments = listOf("batch"),
                            classes = mapOf("checkout" to LoadProfile.constant(0.001)),
                            deadlineMs = 150.0,
                        ),
                        chain.client.copy(
                            pathSegments = listOf("long"),
                            classes = mapOf("checkout" to LoadProfile.constant(0.001)),
                            deadlineMs = 500.0,
                        ),
                        chain.client.copy(
                            pathSegments = listOf("status-only"),
                            classes = mapOf("status" to LoadProfile.constant(0.001)),
                            deadlineMs = 50.0,
                        ),
                    ),
                services =
                    listOf(
                        chain.services[0].copy(
                            scenario = listOf(ServiceStep.Process(), ServiceStep.Call("a-b", setOf("checkout", "lookup"))),
                        ),
                        chain.services[1],
                    ),
                calls = listOf(chain.calls[0].copy(timeoutMs = 150.0)),
            )

        val warning = warnings(changed, "LINT_TIMEOUT_UNREACHABLE").single()

        assertThat(warning.args).containsEntry("clientDeadlines", JsonPrimitive("'client': 100, 'batch': 150"))
        assertThat(warning.args).containsEntry("timeoutMs", JsonPrimitive("150"))
        assertThat(warning.message).contains("'client': 100", "'batch': 150").doesNotContain("long", "status-only", ".0")
    }

    @Test
    fun `router branches do not duplicate unreachable timeouts on their shared prefix`() {
        val changed =
            chain.copy(
                clients = listOf(chain.client.copy(deadlineMs = 100.0)),
                calls = listOf(chain.calls[0].copy(to = "router")),
                routers = listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                routes = listOf(RouteEdge("to-b", "router", "b"), RouteEdge("to-c", "router", "c")),
            )

        val warning = warnings(changed, "LINT_TIMEOUT_UNREACHABLE").single()

        assertThat(warning.args).containsEntry("clientDeadlines", JsonPrimitive("'client': 100"))
        assertThat(warning.args).doesNotContainKey("points")
        assertThat(warning.message).doesNotContain("points:")
    }

    @Test
    fun `call policies do not make a timeout beyond the original deadline protective`() {
        val changed =
            chain.copy(
                clients = listOf(chain.client.copy(deadlineMs = 100.0)),
                calls =
                    listOf(
                        chain.calls[0].copy(
                            circuitBreaker = CircuitBreakerConfig(0.5, 2, 10, 1_000.0, 1),
                            retryBudget = RetryBudgetConfig(0.1, 0.01, 1_000.0),
                            fallback = FallbackConfig(setOf("timeout", "breaker-open"), 1.0),
                        ),
                        chain.calls[1],
                    ),
            )

        assertThat(warnings(changed, "LINT_TIMEOUT_UNREACHABLE").map { it.path }).containsExactly("a-b")
    }

    @Test
    fun `three replicas receive their share of the client load`() {
        val routed = replicaGraph(0.9, 16)

        assertThat(warnings(routed, "LINT_HANDLERS_LITTLE")).isEmpty()
        val overloaded = routed.copy(services = routed.services.map { it.copy(handlers = 10) })
        val findings = warnings(overloaded, "LINT_HANDLERS_LITTLE")
        assertThat(findings.map { it.path }).containsExactly("catalog#1", "catalog#2", "catalog#3")
        assertThat(findings).allSatisfy {
            assertThat(
                it.args
                    ?.get("ratePerSecond")
                    ?.content
                    ?.toDouble(),
            ).isCloseTo(
                300.0,
                org.assertj.core.data.Offset
                    .offset(0.000001),
            )
            assertThat(
                it.args
                    ?.get("demand")
                    ?.content
                    ?.toDouble(),
            ).isCloseTo(
                10.5,
                org.assertj.core.data.Offset
                    .offset(0.000001),
            )
        }
    }

    @Test
    fun `random router distributes load by normalized output weights`() {
        val routed = replicaGraph(1.0, 12)
        val weighted =
            routed.copy(
                services = routed.services.take(2).map { it.copy(processing = fixed(40.0)) },
                routers = routed.routers.map { it.copy(policy = RoutingPolicy.RANDOM) },
                routes = routed.routes.take(2).mapIndexed { index, route -> route.copy(weight = if (index == 0) 3.0 else 1.0) },
            )

        val finding = warnings(weighted, "LINT_HANDLERS_LITTLE").single()
        assertThat(finding.path).isEqualTo("catalog#1")
        assertThat(finding.args).containsEntry("ratePerSecond", JsonPrimitive(750.0)).containsEntry("demand", JsonPrimitive(30.0))
    }

    @Test
    fun `replica demand sums clients and classes after routing`() {
        val routed = replicaGraph(0.9, 13)
        val clients =
            listOf(
                routed.client.copy(classes = mapOf("read" to LoadProfile.constant(0.6), "write" to LoadProfile.constant(0.3))),
                routed.client.copy(pathSegments = listOf("second"), classes = mapOf("read" to LoadProfile.constant(0.3))),
            )

        assertThat(warnings(routed.copy(clients = clients), "LINT_HANDLERS_LITTLE"))
            .allSatisfy {
                assertThat(
                    it.args
                        ?.get("demand")
                        ?.content
                        ?.toDouble(),
                ).isCloseTo(
                    14.0,
                    org.assertj.core.data.Offset
                        .offset(0.000001),
                )
            }.hasSize(3)
    }

    @Test
    fun `initial one second timeouts do not warn about a small downstream reserve`() {
        val initial =
            chain.copy(
                calls = chain.calls.map { it.copy(timeoutMs = 1_000.0, network = fixed(1.0)) },
                services = chain.services.map { it.copy(processing = fixed(10.0)) },
                clients = listOf(chain.client.copy(deadlineMs = 10_000.0)),
            )

        assertThat(ModelLinter().lint(experiment(initial))).isEmpty()
        assertThat(
            ModelLinter()
                .lint(
                    experiment(initial.copy(calls = initial.calls.map { if (it.path == "b-c") it.copy(timeoutMs = 1_100.0) else it })),
                ).filter { it.code == "LINT_TIMEOUT_BUDGET" },
        ).hasSize(1)
    }

    private fun replicaGraph(
        rate: Double,
        handlers: Int,
    ): GraphIr =
        chain.copy(
            clients = listOf(chain.client.copy(entry = "catalog#lb", classes = mapOf("default" to LoadProfile.constant(rate)))),
            services = (1..3).map { service("catalog#$it", 35.0, handlers) },
            calls = emptyList(),
            routers = listOf(RouterNode("catalog#lb", RoutingPolicy.ROUND_ROBIN)),
            routes = (1..3).map { RouteEdge("route-$it", "catalog#lb", "catalog#$it") },
        )

    @Test
    fun `few replications warns below five once across variants and grid points`() {
        listOf(4, 5).forEach { replications ->
            val run = chain.run.copy(replications = replications)
            val points =
                listOf(100, 101).mapIndexed { index, handlers ->
                    CompiledPoint("p$index", mapOf("a.handlers" to JsonPrimitive(handlers)), chain.copy(run = run))
                }
            val experiment =
                CompiledExperiment(
                    listOf(CompiledVariant("one", "One", points), CompiledVariant("two", "Two", points)),
                    run,
                    listOf(GridAxis("a.handlers", listOf(JsonPrimitive(100), JsonPrimitive(101)))),
                )

            val warnings = linter.lint(experiment).filter { it.code == "LINT_FEW_REPLICATIONS" }

            if (replications == 4) {
                assertThat(warnings).hasSize(1)
                val warning = warnings.single()
                assertThat(warning.severity).isEqualTo(Severity.WARNING)
                assertThat(warning.pointer).isEqualTo("/execution/replications")
                assertThat(warning.path).isNull()
                assertThat(warning.variant).isNull()
                assertThat(warning.message).contains("4", "95%", "unreliable", "at least 5")
            } else {
                assertThat(warnings).isEmpty()
            }
        }
    }

    @Test
    fun `minimum replications is a positive rule parameter`() {
        val experiment = experiment(chain.copy(run = chain.run.copy(replications = 4)))

        assertThat(ModelLinter(minimumReplications = 4).lint(experiment).map { it.code }).doesNotContain("LINT_FEW_REPLICATIONS")
        assertThat(ModelLinter(minimumReplications = 5).lint(experiment).single { it.code == "LINT_FEW_REPLICATIONS" }.message)
            .contains("at least 5")
        assertThatThrownBy { ModelLinter(minimumReplications = 0) }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `timeout includes target processing and request and response network delays`() {
        val changed =
            chain.copy(
                calls =
                    listOf(
                        chain.calls[0].copy(timeoutMs = 44.0, network = fixed(2.0)),
                        chain.calls[1].copy(attempts = 2),
                    ),
            )

        val warning = warnings(changed, "LINT_TIMEOUT_BUDGET").single()

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/1/params/timeout")
        assertThat(warning.path).isEqualTo("a-b")
        assertThat(warning.message).contains("Timeout 44 ms", "estimated 46 ms", "increase this timeout")
        assertThat(Json.encodeToJsonElement(warning).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"timeoutMs":44.0,"requiredMs":46.0}"""))
        assertThat(
            warnings(
                changed.copy(
                    calls =
                        changed.calls.map {
                            if (it.path ==
                                "a-b"
                            ) {
                                it.copy(timeoutMs = 46.0)
                            } else {
                                it
                            }
                        },
                ),
                "LINT_TIMEOUT_BUDGET",
            ),
        ).isEmpty()
    }

    @Test
    fun `fractional timeout budgets retain their precision`() {
        val changed =
            chain.copy(
                calls =
                    listOf(
                        chain.calls[0].copy(timeoutMs = 44.25, network = fixed(2.0625)),
                        chain.calls[1].copy(attempts = 2),
                    ),
            )

        assertThat(warnings(changed, "LINT_TIMEOUT_BUDGET").single().message)
            .contains("Timeout 44.25 ms", "estimated 46.125 ms")
    }

    @Test
    fun `timeout includes maximum capped backoffs between downstream attempts`() {
        listOf(
            Backoff(BackoffKind.NONE, 9.0, 5.0, 2.0) to 60.0,
            Backoff(BackoffKind.FIXED, 9.0, 5.0, 2.0) to 70.0,
            Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 4.0, 5.0, 2.0) to 69.0,
            Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 4.0, 5.0, 0.5) to 66.0,
        ).forEach { (backoff, retryBudget) ->
            val budget = retryBudget + 2.0
            val calls = listOf(chain.calls[0].copy(timeoutMs = budget), chain.calls[1].copy(attempts = 3, backoff = backoff))

            assertThat(warnings(chain.copy(calls = calls), "LINT_TIMEOUT_BUDGET")).describedAs(backoff.toString()).isEmpty()
            assertThat(warnings(chain.copy(calls = listOf(calls[0].copy(timeoutMs = budget - 0.5), calls[1])), "LINT_TIMEOUT_BUDGET"))
                .describedAs(backoff.toString())
                .hasSize(1)
        }
    }

    @Test
    fun `retry amplification warns above ten and accepts exactly ten`() {
        val calls = listOf(chain.calls[0].copy(attempts = 2), chain.calls[1].copy(attempts = 5))

        assertThat(warnings(chain.copy(calls = calls), "LINT_RETRY_AMPLIFICATION")).isEmpty()
        val warning = warnings(chain.copy(calls = listOf(calls[0], calls[1].copy(attempts = 6))), "LINT_RETRY_AMPLIFICATION").single()
        assertThat(warning.message).contains("12", "10")
        assertThat(warning.path).isEqualTo("a-b")
        assertThat(warning.pointer).isEqualTo("/connections/1/params/attempts")
    }

    @Test
    fun `retry amplification threshold is a rule parameter`() {
        val experiment = experiment(chain.copy(calls = chain.calls.map { it.copy(attempts = 2) }))

        assertThat(ModelLinter(retryAmplificationThreshold = 4).lint(experiment).map { it.code }).doesNotContain("LINT_RETRY_AMPLIFICATION")
        assertThat(ModelLinter(retryAmplificationThreshold = 3).lint(experiment).single { it.code == "LINT_RETRY_AMPLIFICATION" }.message)
            .contains("4", "3")
    }

    @Test
    fun `large attempt counts neither overflow amplification nor require one iteration per retry`() {
        val changed =
            chain.copy(
                calls =
                    chain.calls.map {
                        it.copy(attempts = Int.MAX_VALUE, backoff = Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 2.0, 5.0, 2.0))
                    },
            )

        val result = assertTimeoutPreemptively<List<Diagnostic>>(Duration.ofSeconds(2)) { linter.lint(experiment(changed)) }

        val amplification = result.single { it.code == "LINT_RETRY_AMPLIFICATION" }
        assertThat(amplification.message).contains("up to 4611686014132420609 attempts", "threshold of 10", "reduce attempts")
        assertThat(
            Json
                .parseToJsonElement(Json.encodeToJsonElement(amplification).toString())
                .jsonObject["args"]
                ?.jsonObject
                ?.get("amplification"),
        ).isEqualTo(JsonPrimitive("4611686014132420609"))
        assertThat(result.single { it.code == "LINT_TIMEOUT_BUDGET" }.message).contains("53687091168")
    }

    @Test
    fun `serialized amplification keeps safe products numeric and unsafe products exact`() {
        listOf(
            Triple(2, 6, JsonPrimitive(12)),
            Triple(441_650_591, 20_394_401, JsonPrimitive(9_007_199_254_740_991L)),
            Triple(67_108_864, 134_217_728, JsonPrimitive("9007199254740992")),
        ).forEach { (first, second, expected) ->
            val changed = chain.copy(calls = listOf(chain.calls[0].copy(attempts = first), chain.calls[1].copy(attempts = second)))
            val warning = warnings(changed, "LINT_RETRY_AMPLIFICATION").single()

            val serialized = Json.parseToJsonElement(Json.encodeToJsonElement(warning).toString()).jsonObject

            assertThat(serialized["args"]?.jsonObject?.get("amplification")).isEqualTo(expected)
        }
    }

    @Test
    fun `amplification beyond double range serializes as exact digits`() {
        val changed =
            chain.copy(
                clients = chain.clients.map { it.copy(entry = "service-0") },
                services = (0..34).map { service("service-$it", 1.0) },
                calls = (0 until 34).map { call("call-$it", "service-$it", "service-${it + 1}", 100.0, Int.MAX_VALUE, it) },
            )
        val expected =
            "1930258275058558013781174127771222627704323231879312339777084929311244263673575522266933054910778922248747" +
                "5683500375425476373412922702694666347347519505694262586290862257808029652511048552481182305723744158551788" +
                "3535138768407979524425801700647735284803347209286676101282529538189531254171895621795751336395553288224769"

        val warning = warnings(changed, "LINT_RETRY_AMPLIFICATION").single()
        val serialized = Json.parseToJsonElement(Json.encodeToJsonElement(warning).toString()).jsonObject

        assertThat(warning.message).contains("up to $expected attempts", "threshold of 10")
        assertThat(serialized["args"]?.jsonObject?.get("amplification")).isEqualTo(JsonPrimitive(expected))
    }

    @Test
    fun `overflowing computed budgets remain advisory`() {
        val changed = chain.copy(calls = chain.calls.map { it.copy(attempts = 2, timeoutMs = Double.MAX_VALUE) })

        val diagnostic = warnings(changed, "LINT_DEADLINE_BUDGET").single()
        assertThat(diagnostic.message).contains("Infinity")
        assertThat(Json.encodeToJsonElement(diagnostic).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"deadlineMs":1000.0,"requiredMs":"Infinity"}"""))
    }

    @Test
    fun `handler demand includes the entire downstream path without retries or faults`() {
        val changed =
            chain.copy(
                clients = listOf(chain.client.copy(classes = mapOf("default" to LoadProfile.constant(0.125)))),
                services = listOf(service("c", 8.0, 1), service("a", 2.0, 1), service("b", 2.0, 2)),
                calls = chain.calls.reversed().map { it.copy(network = fixed(1.0), attempts = 5) },
            )

        val warning = warnings(changed, "LINT_HANDLERS_LITTLE").single { it.path == "a" }

        assertThat(warning.path).isEqualTo("a")
        assertThat(warning.pointer).isEqualTo("/blocks/a/params/handlers")
        assertThat(
            warning.message,
        ).contains("Handlers: 1", "simultaneous demand: 2", "125 requests/s", "increase capacity").doesNotContain("λ")
        assertThat(warning.args).containsEntry("elementType", JsonPrimitive("service"))
        assertThat(
            warnings(
                changed.copy(
                    services =
                        changed.services.map { it.copy(handlers = 3) },
                ),
                "LINT_HANDLERS_LITTLE",
            ),
        ).isEmpty()
    }

    @Test
    fun `deadline includes entry processing and outgoing attempts without counting nested timeouts or network twice`() {
        val changed =
            chain.copy(
                clients = listOf(chain.client.copy(deadlineMs = 201.0)),
                services = chain.services.reversed(),
                calls = chain.calls.map { it.copy(attempts = 2, timeoutMs = it.timeoutMs + 0.125, network = fixed(1.0)) }.reversed(),
            )

        val warning = warnings(changed, "LINT_DEADLINE_BUDGET").single()

        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.path).isEqualTo("client")
        assertThat(warning.pointer).isEqualTo("/blocks/client/params/deadline")
        assertThat(warning.message).contains("Deadline 201 ms", "estimated 201.25 ms", "increase its deadline")
        assertThat(warnings(changed.copy(clients = listOf(changed.client.copy(deadlineMs = 201.25))), "LINT_DEADLINE_BUDGET")).isEmpty()
    }

    @Test
    fun `deadline includes maximum capped backoffs between entry call attempts`() {
        listOf(
            Backoff(BackoffKind.NONE, 9.0, 5.0, 2.0) to 301.0,
            Backoff(BackoffKind.FIXED, 9.0, 5.0, 2.0) to 311.0,
            Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 4.0, 5.0, 2.0) to 310.0,
            Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 4.0, 5.0, 0.5) to 307.0,
        ).forEach { (backoff, budget) ->
            val changed =
                chain.copy(
                    clients = listOf(chain.client.copy(deadlineMs = budget)),
                    calls = listOf(chain.calls[0].copy(attempts = 3, backoff = backoff), chain.calls[1]),
                )

            assertThat(warnings(changed, "LINT_DEADLINE_BUDGET")).describedAs(backoff.toString()).isEmpty()
            assertThat(warnings(changed.copy(clients = listOf(changed.client.copy(deadlineMs = budget - 0.5))), "LINT_DEADLINE_BUDGET"))
                .describedAs(backoff.toString())
                .hasSize(1)
        }
    }

    @Test
    fun `deadline for an entry without outgoing calls covers only its processing`() {
        val single =
            chain.copy(
                clients = listOf(chain.client.copy(deadlineMs = 2.25)),
                services = listOf(service("a", 2.5)),
                calls = emptyList(),
            )

        assertThat(warnings(single, "LINT_DEADLINE_BUDGET").single().message)
            .contains("Deadline 2.25 ms", "estimated 2.5 ms")
        assertThat(warnings(single.copy(clients = listOf(single.client.copy(deadlineMs = 2.5))), "LINT_DEADLINE_BUDGET")).isEmpty()
    }

    @Test
    fun `nested checkout timeouts fit within the entry budget and client deadline`() {
        val checkout =
            chain.copy(
                clients = listOf((chain.client.copy(deadlineMs = 10_000.0)).copy(entry = "gateway")),
                services = listOf(service("gateway", 2.0), service("order", 20.0), service("payment", 10.0), service("psp", 300.0)),
                calls =
                    listOf(
                        call("gateway-order", "gateway", "order", 8_000.0, 1, 1).copy(network = fixed(0.5)),
                        call("order-payment", "order", "payment", 2_200.0, 3, 2).copy(
                            network = fixed(0.5),
                            backoff = Backoff(BackoffKind.FIXED, 500.0, 500.0, 2.0),
                        ),
                        call("payment-psp", "payment", "psp", 1_000.0, 2, 3).copy(
                            network = fixed(20.0),
                            backoff = Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 25.0, 1_000.0, 2.0),
                        ),
                    ),
            )

        val warnings = linter.lint(experiment(checkout))
        assertThat(warnings.map { it.code }).containsExactly("LINT_RETRY_NO_JITTER", "LINT_RETRY_UNGUARDED", "LINT_RETRY_UNGUARDED")
        assertThat(warnings.single { it.code == "LINT_RETRY_NO_JITTER" }.path).isEqualTo("order-payment")
        assertThat(
            warnings(checkout.copy(clients = listOf(checkout.client.copy(deadlineMs = 8_001.0))), "LINT_DEADLINE_BUDGET").single().message,
        ).contains("Deadline 8001 ms", "estimated 8002 ms")
    }

    @Test
    fun `common warnings occur once while different warnings carry their variants`() {
        val a = chain.copy(clients = listOf(chain.client.copy(deadlineMs = 10.0)))
        val b = a.copy(calls = a.calls.map { if (it.path == "a-b") it.copy(timeoutMs = 200.0) else it })
        val result =
            linter.lint(
                CompiledExperiment(
                    listOf(variant("one", "One", a), variant("two", "Two", a), variant("three", "Three", b)),
                    chain.run,
                ),
            )

        val deadlines = result.filter { it.code == "LINT_DEADLINE_BUDGET" }
        assertThat(deadlines).hasSize(3)
        assertThat(deadlines.map { it.variant }).containsExactly("one", "two", "three")
        assertThat(deadlines.count { "101" in it.message }).isEqualTo(2)
        assertThat(deadlines.count { "201" in it.message }).isEqualTo(1)
        assertThat(deadlines).allSatisfy { assertThat(it.message).doesNotContain("variants:") }
        val common = linter.lint(CompiledExperiment(listOf(variant("one", "One", a), variant("two", "Two", a)), chain.run))
        assertThat(common.filter { it.code == "LINT_DEADLINE_BUDGET" }).hasSize(1)
        assertThat(common.single { it.code == "LINT_DEADLINE_BUDGET" }.variant).isNull()
        assertThat(common.single { it.code == "LINT_DEADLINE_BUDGET" }.message).doesNotContain("one", "two")
    }

    @Test
    fun `a single queue free service has capacity and rejection rules`() {
        val single =
            chain.copy(
                clients = listOf(chain.client.copy(classes = mapOf("default" to LoadProfile.constant(1.0)))),
                services = listOf(service("a", 2.0, 1)),
                calls = emptyList(),
            )

        assertThat(linter.lint(experiment(single)).map { it.code }).containsExactly("LINT_HANDLERS_LITTLE", "LINT_REJECTION_RISK")
    }

    private fun warnings(
        chain: GraphIr,
        code: String,
    ): List<Diagnostic> = linter.lint(experiment(chain)).filter { it.code == code }

    private fun experiment(chain: GraphIr) = CompiledExperiment(listOf(variant("base", "Base", chain)), chain.run)

    private fun fixed(meanMs: Double) = Distribution(DistributionShape.FIXED, meanMs)

    private fun service(
        path: String,
        meanMs: Double,
        handlers: Int = 100,
    ) = ServiceNode(path, handlers, 0, fixed(meanMs), 0.0, Origin("m.model.json", "/blocks/$path"))

    private fun call(
        path: String,
        from: String,
        to: String,
        timeoutMs: Double,
        attempts: Int,
        index: Int,
    ) = CallEdge(path, from, to, fixed(0.0), timeoutMs, attempts, noBackoff, Origin("m.model.json", "/connections/$index"))
}
