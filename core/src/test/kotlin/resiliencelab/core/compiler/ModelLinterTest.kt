package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertTimeoutPreemptively
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
            RunSettings(1, 0.0, 1.0, 1L, 30L),
        )

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
        assertThat(warning.message).contains("44", "46")
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

        assertThat(result.single { it.code == "LINT_RETRY_AMPLIFICATION" }.message).contains("4611686014132420609")
        assertThat(result.single { it.code == "LINT_TIMEOUT_BUDGET" }.message).contains("5.3687091168E10")
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
        assertThat(warning.message).contains("1", "2", "16", "125")
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
    fun `deadline compares the sum of per attempt timeouts without counting network twice`() {
        val changed =
            chain.copy(
                client = chain.client.copy(deadlineMs = 239.0),
                calls = chain.calls.map { it.copy(attempts = 2, network = fixed(1.0)) },
            )

        val warning = warnings(changed, "LINT_DEADLINE_BUDGET").single()

        assertThat(warning.path).isEqualTo("client")
        assertThat(warning.pointer).isEqualTo("/blocks/client/params/deadline")
        assertThat(warning.message).contains("239", "240")
        assertThat(warnings(changed.copy(client = changed.client.copy(deadlineMs = 240.0)), "LINT_DEADLINE_BUDGET")).isEmpty()
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
        assertThat(deadlines.count { "120" in it.message }).isEqualTo(2)
        assertThat(deadlines.count { "220" in it.message }).isEqualTo(1)
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
