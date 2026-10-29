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
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import java.time.Duration
import kotlin.test.Test

class ModelLinterTest {
    private fun variant(
        id: String,
        label: String,
        chain: ChainIr,
    ) = CompiledVariant(id, label, listOf(CompiledPoint("p0", emptyMap(), chain)))

    private val linter = ModelLinter()
    private val noBackoff = Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0)
    private val chain =
        ChainIr(
            ClientNode("client", 0.001, 1_000.0, Origin("m.model.json", "/blocks/client")),
            "a",
            listOf(service("a", 1.0), service("b", 2.0), service("c", 8.0)),
            listOf(call("a-b", "a", "b", 100.0, 1, 1), call("b-c", "b", "c", 20.0, 1, 2)),
            emptyList(),
            RunSettings(5, 0.0, 1.0, 1L, 30L),
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
        assertThat(warning.message).isEqualTo("Timeout 44 ms is below the downstream budget 46 ms")
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
            .isEqualTo("Timeout 44.25 ms is below the downstream budget 46.125 ms")
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
        assertThat(amplification.message).isEqualTo("Retry amplification 4611686014132420609 exceeds threshold 10")
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
                entry = "service-0",
                services = (0..34).map { service("service-$it", 1.0) },
                calls = (0 until 34).map { call("call-$it", "service-$it", "service-${it + 1}", 100.0, Int.MAX_VALUE, it) },
            )
        val expected =
            "1930258275058558013781174127771222627704323231879312339777084929311244263673575522266933054910778922248747" +
                "5683500375425476373412922702694666347347519505694262586290862257808029652511048552481182305723744158551788" +
                "3535138768407979524425801700647735284803347209286676101282529538189531254171895621795751336395553288224769"

        val warning = warnings(changed, "LINT_RETRY_AMPLIFICATION").single()
        val serialized = Json.parseToJsonElement(Json.encodeToJsonElement(warning).toString()).jsonObject

        assertThat(warning.message).isEqualTo("Retry amplification $expected exceeds threshold 10")
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
                client = chain.client.copy(arrivalRatePerMs = 0.125),
                services = listOf(service("c", 8.0, 1), service("a", 2.0, 1), service("b", 2.0, 2)),
                calls = chain.calls.reversed().map { it.copy(network = fixed(1.0), attempts = 5) },
            )

        val warning = warnings(changed, "LINT_HANDLERS_LITTLE").single()

        assertThat(warning.path).isEqualTo("a")
        assertThat(warning.pointer).isEqualTo("/blocks/a/params/handlers")
        assertThat(warning.message).isEqualTo("Handlers 1 are below λ·W = 2 (λ = 125 requests/s, W = 16 ms)")
        assertThat(
            warnings(
                changed.copy(
                    services =
                        changed.services.map {
                            if (it.path ==
                                "a"
                            ) {
                                it.copy(handlers = 2)
                            } else {
                                it
                            }
                        },
                ),
                "LINT_HANDLERS_LITTLE",
            ),
        ).isEmpty()
    }

    @Test
    fun `deadline includes entry processing and outgoing attempts without counting nested timeouts or network twice`() {
        val changed =
            chain.copy(
                client = chain.client.copy(deadlineMs = 201.0),
                services = chain.services.reversed(),
                calls = chain.calls.map { it.copy(attempts = 2, timeoutMs = it.timeoutMs + 0.125, network = fixed(1.0)) }.reversed(),
            )

        val warning = warnings(changed, "LINT_DEADLINE_BUDGET").single()

        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.path).isEqualTo("client")
        assertThat(warning.pointer).isEqualTo("/blocks/client/params/deadline")
        assertThat(warning.message).isEqualTo("Deadline 201 ms is below the entry call budget 201.25 ms")
        assertThat(warnings(changed.copy(client = changed.client.copy(deadlineMs = 201.25)), "LINT_DEADLINE_BUDGET")).isEmpty()
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
                    client = chain.client.copy(deadlineMs = budget),
                    calls = listOf(chain.calls[0].copy(attempts = 3, backoff = backoff), chain.calls[1]),
                )

            assertThat(warnings(changed, "LINT_DEADLINE_BUDGET")).describedAs(backoff.toString()).isEmpty()
            assertThat(warnings(changed.copy(client = changed.client.copy(deadlineMs = budget - 0.5)), "LINT_DEADLINE_BUDGET"))
                .describedAs(backoff.toString())
                .hasSize(1)
        }
    }

    @Test
    fun `deadline for an entry without outgoing calls covers only its processing`() {
        val single =
            chain.copy(
                services = listOf(service("a", 2.5)),
                calls = emptyList(),
                client = chain.client.copy(deadlineMs = 2.25),
            )

        assertThat(warnings(single, "LINT_DEADLINE_BUDGET").single().message)
            .isEqualTo("Deadline 2.25 ms is below the entry call budget 2.5 ms")
        assertThat(warnings(single.copy(client = single.client.copy(deadlineMs = 2.5)), "LINT_DEADLINE_BUDGET")).isEmpty()
    }

    @Test
    fun `nested checkout timeouts fit within the entry budget and client deadline`() {
        val checkout =
            chain.copy(
                client = chain.client.copy(deadlineMs = 10_000.0),
                entry = "gateway",
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

        assertThat(linter.lint(experiment(checkout))).isEmpty()
        assertThat(warnings(checkout.copy(client = checkout.client.copy(deadlineMs = 8_001.0)), "LINT_DEADLINE_BUDGET").single().message)
            .isEqualTo("Deadline 8001 ms is below the entry call budget 8002 ms")
    }

    @Test
    fun `common warnings occur once while different warnings carry their variants`() {
        val a = chain.copy(client = chain.client.copy(deadlineMs = 10.0))
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
    fun `a single service has only the capacity rule`() {
        val single =
            chain.copy(
                services = listOf(service("a", 2.0, 1)),
                calls = emptyList(),
                client = chain.client.copy(arrivalRatePerMs = 1.0),
            )

        assertThat(linter.lint(experiment(single)).map { it.code }).containsExactly("LINT_HANDLERS_LITTLE")
    }

    private fun warnings(
        chain: ChainIr,
        code: String,
    ): List<Diagnostic> = linter.lint(experiment(chain)).filter { it.code == code }

    private fun experiment(chain: ChainIr) = CompiledExperiment(listOf(variant("base", "Base", chain)), chain.run)

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
