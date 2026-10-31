package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.CircuitBreakerConfig
import resiliencelab.core.ir.FallbackConfig
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RetryBudgetConfig
import resiliencelab.core.results.ConnectionWindow
import resiliencelab.core.results.NodeWindow

class CallPoliciesTest {
    @Test
    fun `policies reset between replications of the same model`() {
        val base = graph()
        val breaker = base.copy(calls = listOf(base.calls.single().copy(circuitBreaker = CircuitBreakerConfig(1.0, 1, 1, 10_000.0, 1))))
        val circuit = simulate(breaker, listOf(0.0), replications = 2).result.connections.getValue(CALL)
        assertThat(circuit.sentAttempts).isEqualTo(1)
        assertThat(circuit.circuitRejections).isZero()
        val budget =
            base.copy(
                calls = listOf(base.calls.single().copy(attempts = 3, retryBudget = RetryBudgetConfig(0.0, 0.0001, 10_000.0))),
            )
        val retries = simulate(budget, listOf(0.0), replications = 2).result.connections.getValue(CALL)
        assertThat(retries.sentAttempts).isEqualTo(2)
        assertThat(retries.retriesDenied).isEqualTo(1)
    }

    @Test
    fun `breaker rejection bypasses network and pool and never spends retry budget`() {
        val base = graph()
        val policy =
            base.calls.single().copy(
                circuitBreaker = CircuitBreakerConfig(1.0, 1, 1, 20.0, 1),
                retryBudget = RetryBudgetConfig(0.0, 0.1, 10.0),
                pool = CallPool(1, 100.0),
                attempts = 3,
            )
        val rig = simulate(base.copy(calls = listOf(policy)), listOf(0.0))
        val call = rig.result.connections.getValue(CALL)
        assertThat(call.sentAttempts).isEqualTo(1)
        assertThat(call.circuitRejections).isEqualTo(2)
        assertThat(call.retriesDenied).isZero()
        assertThat(call.slotPools.getValue("pool").busyIntegralMs).isEqualTo(1.0)
        assertThat(call.slotPools.getValue("pool").waitCount).isZero()
        assertThat(
            rig.result.services
                .getValue("backend")
                .offeredAttempts,
        ).isEqualTo(1)
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("circuitOpen" to 1))
    }

    @Test
    fun `calling instances keep independent circuit state`() {
        val base = graph()
        val other = base.services.first().copy(pathSegments = listOf("other"))
        val call = base.calls.single().copy(circuitBreaker = CircuitBreakerConfig(1.0, 1, 1, 100.0, 1))
        val copy = call.copy(pathSegments = listOf("other-call"), from = "other")
        val rig =
            simulate(
                base.copy(services = base.services + other, calls = listOf(call, copy)),
                listOf(0.0, 2.0, 4.0, 6.0),
                listOf("entry", "entry", "other", "other"),
            )
        for (id in listOf(CALL, "other-call")) {
            assertThat(
                rig.result.connections
                    .getValue(id)
                    .sentAttempts,
            ).isEqualTo(1)
            assertThat(
                rig.result.connections
                    .getValue(id)
                    .circuitRejections,
            ).isEqualTo(1)
        }
    }

    @Test
    fun `breaker opens after its minimum and retries do not send work while open`() {
        val graph = graph().let { it.copy(calls = listOf(it.calls.single().copy(circuitBreaker = breaker()))) }
        val rig = simulate(graph, listOf(0.0, 2.0, 4.0, 6.0, 14.0, 16.0, 18.0))
        val call = rig.result.connections.getValue(CALL)
        assertThat(call.sentAttempts).isEqualTo(4)
        assertThat(call.circuitRejections).isEqualTo(3)
        assertThat(call.circuitOpenMs).isEqualTo(20.0)
        assertThat(rig.calls.map { it.metrics.circuitOpenMs }).containsExactly(7.0, 6.0, 7.0)
        assertThat(
            rig.result.services
                .getValue("backend")
                .offeredAttempts,
        ).isEqualTo(4)
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyInAnyOrderEntriesOf(mapOf("error" to 4, "circuitOpen" to 3))
    }

    @Test
    fun `retry budget denies without replacing the last failure and recovers when retries expire`() {
        val graph =
            graph().let {
                it.copy(calls = listOf(it.calls.single().copy(attempts = 5, retryBudget = RetryBudgetConfig(0.0, 0.1, 10.0))))
            }
        val rig = simulate(graph, listOf(0.0, 20.0))
        val call = rig.result.connections.getValue(CALL)
        assertThat(call.sentAttempts).isEqualTo(4)
        assertThat(call.retries).isEqualTo(2)
        assertThat(call.retriesDenied).isEqualTo(2)
        assertThat(rig.calls.sumOf { it.metrics.retriesDenied }).isEqualTo(2)
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("error" to 2))
        assertThat(
            rig.result.services
                .getValue("entry")
                .retries,
        ).isEqualTo(2)
    }

    @Test
    fun `fallback replaces only the final failure after every attempt and marks success as degraded`() {
        val graph =
            graph().let {
                it.copy(calls = listOf(it.calls.single().copy(attempts = 3, fallback = FallbackConfig(setOf("error"), 3.0))))
            }
        val rig = simulate(graph, listOf(0.0))
        val entry = rig.result.entries.total
        assertThat(entry.successes).isEqualTo(1)
        assertThat(entry.degraded).isEqualTo(1)
        assertThat(entry.allLatency.sumMs).isEqualTo(6.0)
        assertThat(entry.failuresByReason).isEmpty()
        assertThat(
            rig.result.entries.clients
                .getValue("client")
                .degraded,
        ).isEqualTo(1)
        assertThat(
            rig.result.entries.classes
                .getValue("default")
                .degraded,
        ).isEqualTo(1)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .failed,
        ).isEqualTo(3)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .fallbacks,
        ).isEqualTo(1)
        assertThat(rig.calls.sumOf { it.metrics.fallbacks }).isEqualTo(1)
        assertThat(rig.nodes.filter { it.id == "client" }.sumOf { it.metrics.degraded }).isEqualTo(1)
        assertThat(
            rig.result.services
                .getValue("entry")
                .failuresByReason,
        ).isEmpty()
    }

    @Test
    fun `fallback does not replace an unlisted reason or an expired deadline`() {
        val base = graph()
        val mismatch = base.copy(calls = listOf(base.calls.single().copy(fallback = FallbackConfig(setOf("timeout"), 2.0))))
        val missed = simulate(mismatch, listOf(0.0)).result
        assertThat(missed.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("error" to 1))
        assertThat(missed.connections.getValue(CALL).fallbacks).isZero()
        val expires =
            base.copy(
                clients = listOf(base.client.copy(deadlineMs = 5.0)),
                calls = listOf(base.calls.single().copy(fallback = FallbackConfig(setOf("error"), 10.0))),
            )
        val expired = simulate(expires, listOf(0.0)).result
        assertThat(expired.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("deadline" to 1))
        assertThat(expired.entries.total.degraded).isZero()
        assertThat(expired.connections.getValue(CALL).fallbacks).isZero()
    }

    @Test
    fun `open duration includes warmup state but counts only the measurement interval`() {
        val base = graph()
        val graph =
            base.copy(
                run = base.run.copy(warmupMs = 10.0, measurementMs = 20.0),
                calls = listOf(base.calls.single().copy(circuitBreaker = CircuitBreakerConfig(1.0, 1, 1, 20.0, 1))),
            )
        val rig = simulate(graph, listOf(0.0, 15.0, 29.0))
        val call = rig.result.connections.getValue(CALL)
        assertThat(call.circuitOpenMs).isEqualTo(11.0)
        assertThat(call.circuitRejections).isEqualTo(1)
        assertThat(rig.calls.map { it.metrics.circuitOpenMs }).containsExactly(9.0, 10.0, 1.0)
        assertThat(rig.calls.sumOf { it.metrics.circuitRejections }).isEqualTo(1)
    }

    @Test
    fun `a nested fallback reaches the original only through a successful response`() {
        val base = graph()
        val middle = base.services.first().copy(pathSegments = listOf("middle"))
        val first = base.calls.single().copy(to = "middle")
        val second =
            base.calls.single().copy(
                pathSegments = listOf("middle-to-backend"),
                from = "middle",
                fallback = FallbackConfig(setOf("error"), 2.0),
            )
        val rig = simulate(base.copy(services = base.services + middle, calls = listOf(first, second)), listOf(0.0))
        assertThat(rig.result.entries.total.successes).isEqualTo(1)
        assertThat(rig.result.entries.total.degraded).isEqualTo(1)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .fallbacks,
        ).isZero()
        assertThat(
            rig.result.connections
                .getValue("middle-to-backend")
                .fallbacks,
        ).isEqualTo(1)
    }

    private fun breaker() = CircuitBreakerConfig(0.5, 2, 4, 10.0, 2)

    private fun graph(): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                listOf(
                    base.services[0].copy(handlers = 10, processing = TestChains.fixed(0.0)),
                    base.services[1].copy(handlers = 10, processing = TestChains.fixed(1.0), failureProbability = 1.0),
                ),
            calls = listOf(base.calls.single().copy(attempts = 1)),
            run = base.run.copy(measurementMs = 30.0, windowMs = 10.0),
        )
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double>,
        targets: List<String> = List(arrivals.size) { graph.entry },
        replications: Int = 1,
    ): Rig {
        val model = Model("CallPoliciesTest", autoCSVReports = false)
        val nodes = mutableListOf<NodeWindow>()
        val calls = mutableListOf<ConnectionWindow>()
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability =
            ReliabilityModel(model, graph, streams, onWindow = { _, n, c ->
                nodes += n
                calls += c
            })
        object : ProcessModel(model, name = "policy-driver") {
            override fun initialize() {
                arrivals.forEachIndexed { index, arrival ->
                    reliability.invoke(
                        targets[index],
                        arrival,
                        originalRequest = true,
                        measurementCohort = arrival >= graph.run.warmupMs,
                    )
                }
            }
        }
        model.numberOfReplications = replications
        model.lengthOfReplication = 1_000.0
        model.simulate()
        reliability.metrics.verifyConnectionsDrained()
        return Rig(reliability.metrics.replicationResult(), nodes, calls)
    }

    private data class Rig(
        val result: ReplicationResult,
        val nodes: List<NodeWindow>,
        val calls: List<ConnectionWindow>,
    )

    companion object {
        private const val CALL = "entry-to-backend"
    }
}
