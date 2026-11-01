package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
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
import kotlin.test.Test

class ModelLinterLatencyTest {
    private val run = RunSettings(5, 0.0, 1.0, 1L, 30L)
    private val graph =
        GraphIr(
            ClientNode("client", 0.001, 10_000.0),
            "a",
            listOf(service("a", fixed(1.0)), service("b", fixed(100.125))),
            listOf(call("a-b", "a", "b", 106.624).copy(network = fixed(3.25))),
            emptyList(),
            run,
        )

    @Test
    fun `fixed processing includes both network means and allows exact equality`() {
        val warning = warnings(graph).single()

        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.path).isEqualTo("a-b")
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/0/params/timeout")
        assertThat(warning.message).contains("106.624 ms", "response 107 ms", "p99", "b", "0.99")
        assertThat(warning.args)
            .containsEntry("timeoutMs", JsonPrimitive("106.624"))
            .containsEntry("estimatedMs", JsonPrimitive("107"))
            .containsEntry("quantile", JsonPrimitive("0.99"))
        assertThat(warnings(graph.copy(calls = listOf(graph.calls.single().copy(timeoutMs = 106.625))))).isEmpty()
    }

    @Test
    fun `formats normal response estimates with significant digits without contradicting the timeout`() {
        listOf(
            Triple(845.23374, 500.0, "845"),
            Triple(845.23374, 845.0, "845.2"),
            Triple(845.23374, 845.1, "845.2"),
            Triple(845.23374, 845.22, "845.23"),
            Triple(0.012345, 0.01, "0.0123"),
            Triple(12_345.0, 10_000.0, "12300"),
        ).forEach { (estimate, timeout, displayed) ->
            val changed =
                graph.copy(
                    services = listOf(graph.services.first(), service("b", fixed(estimate))),
                    calls = listOf(graph.calls.single().copy(timeoutMs = timeout, network = fixed(0.0))),
                )

            val warning = warnings(changed).single()

            assertThat(warning.args).containsEntry("estimatedMs", JsonPrimitive(displayed))
            assertThat(warning.message).contains("response $displayed ms")
        }
    }

    @Test
    fun `exponential and lognormal processing use p99 rather than the mean`() {
        listOf(
            Triple(Distribution(DistributionShape.EXPONENTIAL, 100.0), 470.5170185988091, "471"),
            Triple(Distribution(DistributionShape.LOGNORMAL, 300.0, 150.0), 815.2337429414625, "815.234"),
            Triple(Distribution(DistributionShape.LOGNORMAL, 300.0, 0.0), 310.0, "310"),
        ).forEach { (processing, expected, displayed) ->
            val changed =
                graph.copy(
                    services = listOf(graph.services.first(), service("b", processing)),
                    calls = listOf(graph.calls.single().copy(timeoutMs = expected - 0.001, network = fixed(5.0))),
                )
            val warning = warnings(changed).single()

            val estimate = warning.args?.get("estimatedMs")?.content
            assertThat(estimate).isEqualTo(displayed)
            assertThat(warnings(changed.copy(calls = listOf(changed.calls.single().copy(timeoutMs = expected + 0.001))))).isEmpty()
        }
    }

    @Test
    fun `lognormal with negligible spread preserves fixed processing equality`() {
        listOf(0.0, 1e-200).forEach { stdDev ->
            val changed =
                graph.copy(
                    services = listOf(graph.services.first(), service("b", Distribution(DistributionShape.LOGNORMAL, 0.1, stdDev))),
                    calls = listOf(graph.calls.single().copy(timeoutMs = 0.1, network = fixed(0.0))),
                )

            assertThat(warnings(changed)).describedAs("standard deviation $stdDev").isEmpty()
        }
    }

    @Test
    fun `compiler accepted lognormal moments with an extreme ratio do not produce NaN warnings`() {
        val fixtures = ReplicaGroupsTest()
        val source =
            fixtures.model(
                3,
                overrides =
                    """, "replicaOverrides":{
                        "1":{"processing":{"kind":"lognormal","mean":"1e-100ms","stdDev":"1e100ms"}}
                    }""",
            )
        val compiled = fixtures.compile(source)
        assertThat(compiled.diagnostics).isEmpty()

        assertThat(ModelLinter().lint(requireNotNull(compiled.experiment)))
            .noneMatch { it.code == "LINT_TIMEOUT_BELOW_LATENCY" }
    }

    @Test
    fun `nested calls contribute normal means without timeouts retries backoff or policies`() {
        val changed =
            graph.copy(
                services =
                    listOf(
                        graph.services.first(),
                        service("b", fixed(20.0)),
                        service("c", Distribution(DistributionShape.EXPONENTIAL, 100.0)).copy(failureProbability = 1.0),
                        service("d", fixed(30.0)),
                    ),
                calls =
                    listOf(
                        call("a-b", "a", "b", 167.0).copy(network = fixed(2.0)),
                        call("b-c", "b", "c", 1.0).copy(
                            network = fixed(3.0),
                            attempts = 7,
                            backoff = Backoff(BackoffKind.FIXED, 1_000.0, 1_000.0, 2.0),
                            circuitBreaker = CircuitBreakerConfig(0.5, 2, 10, 1_000.0, 1),
                            retryBudget = RetryBudgetConfig(0.1, 0.01, 1_000.0),
                            fallback = FallbackConfig(setOf("timeout"), 2_000.0),
                        ),
                        call("c-d", "c", "d", 1_000.0).copy(network = fixed(4.0)),
                    ),
            )

        val warning = warnings(changed).single { it.path == "a-b" }

        assertThat(warning.args).containsEntry("estimatedMs", JsonPrimitive("168"))
        assertThat(warnings(changed.copy(calls = changed.calls.map { if (it.path == "a-b") it.copy(timeoutMs = 168.0) else it })))
            .noneMatch { it.path == "a-b" }
    }

    @Test
    fun `request types use only their processing and call steps without duplicate clients`() {
        val changed =
            graph.copy(
                clients =
                    listOf(
                        graph.client.copy(
                            classes = mapOf("checkout" to LoadProfile.constant(0.001), "status" to LoadProfile.constant(0.001)),
                        ),
                        graph.client.copy(pathSegments = listOf("second"), classes = mapOf("checkout" to LoadProfile.constant(0.002))),
                    ),
                services =
                    listOf(
                        graph.services.first(),
                        service("b", fixed(10.0)).copy(
                            scenario =
                                listOf(
                                    ServiceStep.Process(),
                                    ServiceStep.Process(fixed(5.0), classes = setOf("status")),
                                    ServiceStep.Call("b-c", setOf("checkout")),
                                ),
                        ),
                        service("c", fixed(100.0)),
                    ),
                calls =
                    listOf(
                        graph.calls.single().copy(timeoutMs = 18.0, network = fixed(2.0)),
                        call("b-c", "b", "c", 1_000.0).copy(network = fixed(3.0)),
                    ),
            )

        val findings = warnings(changed)

        assertThat(findings).hasSize(2)
        assertThat(findings.single { it.args?.get("requestTypes")?.content == "checkout" }.args)
            .containsEntry("estimatedMs", JsonPrimitive("120"))
        assertThat(findings.single { it.args?.get("requestTypes")?.content == "status" }.args)
            .containsEntry("estimatedMs", JsonPrimitive("19"))
        assertThat(findings).allSatisfy { assertThat(it.message).contains(it.args?.get("requestTypes")!!.content) }
    }

    @Test
    fun `router and group targets warn once naming the slowest applicable replica`() {
        val changed =
            graph.copy(
                services = listOf(graph.services.first(), service("b#1", fixed(10.0)), service("b#2", fixed(50.0))),
                calls = listOf(graph.calls.single().copy(to = "b#lb", timeoutMs = 30.0, network = fixed(0.0))),
                routers = listOf(RouterNode("b#lb", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf(RouteEdge("first", "b#lb", "b#1"), RouteEdge("second", "b#lb", "b#2")),
            )

        val warning = warnings(changed).single()

        assertThat(warning.path).isEqualTo("a-b")
        assertThat(warning.message).contains("b#2", "50 ms")
        assertThat(warning.args).containsEntry("target", JsonPrimitive("b#2"))
        val filtered = changed.copy(routes = changed.routes.map { if (it.to == "b#2") it.copy(classes = setOf("other")) else it })
        assertThat(warnings(filtered)).isEmpty()
    }

    @Test
    fun `quantile is configurable within the open probability interval`() {
        val changed =
            graph.copy(
                services = listOf(graph.services.first(), service("b", Distribution(DistributionShape.EXPONENTIAL, 100.0))),
                calls = listOf(graph.calls.single().copy(timeoutMs = 76.0)),
            )

        assertThat(warnings(changed)).hasSize(1)
        assertThat(warnings(changed, ModelLinter(timeoutLatencyQuantile = 0.5))).isEmpty()
        val median =
            warnings(changed.copy(calls = listOf(changed.calls.single().copy(timeoutMs = 70.0))), ModelLinter(timeoutLatencyQuantile = 0.5))
        assertThat(median.single().args).containsEntry("quantile", JsonPrimitive("0.5")).containsEntry("percentile", JsonPrimitive("50"))
        listOf(0.0, 1.0, -0.1, 1.1, Double.NaN, Double.POSITIVE_INFINITY).forEach { quantile ->
            assertThatThrownBy { ModelLinter(timeoutLatencyQuantile = quantile) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `equal estimates across request types are grouped once and unused calls are ignored`() {
        val changed =
            graph
                .copy(
                    clients =
                        listOf(
                            graph.client.copy(
                                classes = mapOf("read" to LoadProfile.constant(0.001), "write" to LoadProfile.constant(0.001)),
                            ),
                            graph.client.copy(pathSegments = listOf("second"), classes = mapOf("read" to LoadProfile.constant(0.001))),
                        ),
                    services = graph.services + service("unused", fixed(1_000.0)),
                    calls = graph.calls + call("unused-call", "a", "unused", 1.0),
                ).let {
                    it.copy(
                        services =
                            it.services.map { service ->
                                if (service.path ==
                                    "a"
                                ) {
                                    service.copy(scenario = listOf(ServiceStep.Call("a-b")))
                                } else {
                                    service
                                }
                            },
                    )
                }

        val warning = warnings(changed).single()

        assertThat(warning.path).isEqualTo("a-b")
        assertThat(warning.args).containsEntry("requestTypes", JsonPrimitive("read, write"))
    }

    private fun warnings(
        graph: GraphIr,
        linter: ModelLinter = ModelLinter(),
    ): List<Diagnostic> =
        linter
            .lint(CompiledExperiment(listOf(CompiledVariant("base", "Base", listOf(CompiledPoint("p0", emptyMap(), graph)))), run))
            .filter { it.code == "LINT_TIMEOUT_BELOW_LATENCY" }

    private fun fixed(meanMs: Double) = Distribution(DistributionShape.FIXED, meanMs)

    private fun service(
        path: String,
        processing: Distribution,
    ) = ServiceNode(path, 100, 0, processing, 0.0)

    private fun call(
        path: String,
        from: String,
        to: String,
        timeout: Double,
    ) = CallEdge(
        path,
        from,
        to,
        fixed(0.0),
        timeout,
        1,
        Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0),
        Origin("m.model.json", "/connections/0"),
    )
}
