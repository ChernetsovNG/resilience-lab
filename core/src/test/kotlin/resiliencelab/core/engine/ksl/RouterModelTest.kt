package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import resiliencelab.core.results.ConnectionWindow
import kotlin.test.Test

class RouterModelTest {
    @Test
    fun `round robin counts each selected output in totals and event windows`() {
        val rig = simulate(graph(), (0..6).map(Int::toDouble))
        assertThat(counts(rig)).containsExactly(3, 2, 2)
        assertThat(rig.invocations.map { it.outcome }).containsOnly(AttemptOutcome.SUCCEEDED)
        assertThat(rig.windows.groupBy { it.id }.mapValues { (_, rows) -> rows.sumOf { it.metrics.sentAttempts } })
            .containsEntry("route-a", 3)
            .containsEntry("route-b", 2)
            .containsEntry("route-c", 2)
    }

    @Test
    fun `random routing respects weights without consuming other element streams`() {
        val base = graph(RoutingPolicy.RANDOM)
        val weighted = base.copy(routes = base.routes.mapIndexed { i, route -> route.copy(weight = listOf(1.0, 3.0, 6.0)[i]) })
        val rig = simulate(weighted, List(10_000) { it / 100.0 })
        counts(rig).zip(listOf(0.1, 0.3, 0.6)).forEach { (count, fraction) ->
            assertThat(count / 10_000.0).isCloseTo(fraction, offset(0.015))
        }
        val extended =
            weighted.copy(
                services = weighted.services + weighted.services.last().copy(pathSegments = listOf("d")),
                routes = weighted.routes + RouteEdge("route-d", "router", "d"),
            )
        val keys = PathStreams.keys(weighted, 0)
        assertThat(keys.map { it.role }).contains("routing")
        val expanded = StreamPlan(PathStreams.keys(extended, 0))
        val original = StreamPlan(keys)
        keys.forEach { key -> assertThat(expanded.address(key)).isEqualTo(original.address(key)) }
    }

    @Test
    fun `least in flight avoids slow output and breaks ties by route path`() {
        val base = graph(RoutingPolicy.LEAST_IN_FLIGHT)
        val slow = base.copy(services = base.services.map { if (it.path == "a") it.copy(processing = TestChains.fixed(50.0)) else it })
        val rig = simulate(slow, (0..6).map(Int::toDouble))
        assertThat(counts(rig).first()).isEqualTo(1)
        assertThat(counts(rig).sum()).isEqualTo(7)
        assertThat(counts(simulate(base.copy(routes = base.routes.reversed()), List(4) { 0.0 }))).containsExactly(2, 1, 1)
    }

    @Test
    fun `other tries every output before reusing one and works with a single output`() {
        for (policy in RoutingPolicy.entries) {
            val base = graph(policy)
            val failing =
                base.copy(
                    services = base.services.map { if (it.path == "gateway") it else it.copy(failureProbability = 1.0) },
                    calls = base.calls.map { it.copy(attempts = 3, retryTarget = RetryTarget.OTHER) },
                )
            assertThat(counts(simulate(failing))).containsExactly(1, 1, 1)
            val single = failing.copy(services = failing.services.take(2), routes = failing.routes.take(1))
            assertThat(counts(simulate(single), single)).containsExactly(3)
        }
        val base = graph(RoutingPolicy.LEAST_IN_FLIGHT)
        val failing =
            base.copy(
                services = base.services.map { if (it.path == "gateway") it else it.copy(failureProbability = 1.0) },
                calls = base.calls.map { it.copy(attempts = 5, retryTarget = RetryTarget.OTHER) },
            )
        assertThat(counts(simulate(failing))).containsExactly(3, 1, 1)
        assertThat(counts(simulate(failing.copy(calls = failing.calls.map { it.copy(retryTarget = RetryTarget.ANY) }))))
            .containsExactly(5, 0, 0)
    }

    @Test
    fun `retry history belongs to one call invocation and resets for a repeated scenario step`() {
        val base = graph(RoutingPolicy.LEAST_IN_FLIGHT)
        val graph =
            base.copy(
                services =
                    base.services.take(3).map {
                        when (it.path) {
                            "a" -> it.copy(failureProbability = 1.0)
                            "gateway" -> it.copy(scenario = listOf(ServiceStep.Call("call"), ServiceStep.Call("call")))
                            else -> it
                        }
                    },
                routes = base.routes.take(2),
                calls = base.calls.map { it.copy(attempts = 2, retryTarget = RetryTarget.OTHER) },
            )
        val rig = simulate(graph)
        assertThat(counts(rig, graph)).containsExactly(2, 2)
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .connections
                .getValue("call")
                .retries,
        ).isEqualTo(2)
    }

    @Test
    fun `timed out work stays in flight for routing until its response ends`() {
        val base = graph(RoutingPolicy.LEAST_IN_FLIGHT)
        val graph =
            base.copy(
                services = base.services.take(3).map { if (it.path == "a") it.copy(processing = TestChains.fixed(20.0)) else it },
                routes = base.routes.take(2),
                calls = base.calls.map { it.copy(timeoutMs = 5.0, attempts = 2) },
            )
        val rig = simulate(graph)
        assertThat(counts(rig, graph)).containsExactly(1, 1)
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(6.0)
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .connections
                .getValue("call")
                .orphanedIntegralMs,
        ).isEqualTo(15.0)
        assertThat(rig.reliability.activeDownstreamProcesses).isZero()
        rig.reliability.metrics.verifyConnectionsDrained()
    }

    @Test
    fun `nested routers add no delay and incoming call owns the entire network and timeout`() {
        val base = graph()
        val graph =
            base.copy(
                services = base.services.take(2).map { if (it.path == "a") it.copy(processing = TestChains.fixed(4.0)) else it },
                routers = base.routers + RouterNode("nested", RoutingPolicy.ROUND_ROBIN),
                routes = listOf(RouteEdge("outer", "router", "nested"), RouteEdge("inner", "nested", "a")),
                calls = base.calls.map { it.copy(network = TestChains.fixed(3.0), timeoutMs = 10.0) },
            )
        val rig = simulate(graph)
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(10.0)
        assertThat(
            rig.reliability.metrics
                .replicationResult()
                .connections
                .mapValues { it.value.sentAttempts },
        ).containsEntry("outer", 1)
            .containsEntry("inner", 1)
            .containsEntry("call", 1)
    }

    private fun graph(policy: RoutingPolicy = RoutingPolicy.ROUND_ROBIN): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            entry = "gateway",
            services =
                listOf(ServiceNode("gateway", 100, 0, TestChains.fixed(0.0), 0.0)) +
                    listOf("a", "b", "c").map { ServiceNode(it, 100, 0, TestChains.fixed(1.0), 0.0) },
            calls = listOf(CallEdge("call", "gateway", "router", TestChains.fixed(0.0), 100.0, 1, TestChains.noBackoff)),
            routers = listOf(RouterNode("router", policy)),
            routes = listOf("a", "b", "c").map { RouteEdge("route-$it", "router", it) },
            run = base.run.copy(measurementMs = 100.0, windowMs = 10.0),
        )
    }

    private fun counts(
        rig: Rig,
        graph: GraphIr = graph(),
    ): List<Int> =
        graph.routes.map {
            rig.reliability.metrics
                .replicationResult()
                .connections
                .getValue(it.path)
                .sentAttempts
        }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double> = listOf(0.0),
    ): Rig {
        val model = Model("RouterModelTest", autoCSVReports = false)
        val windows = mutableListOf<ConnectionWindow>()
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(model, graph, streams, onWindow = { _, _, connections -> windows += connections })
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(model, name = "router-driver") {
            override fun initialize() {
                arrivals.forEach { invocations += reliability.invoke(graph.entry, it, originalRequest = true) }
            }
        }
        model.numberOfReplications = 1
        model.lengthOfReplication = 250.0
        model.simulate()
        return Rig(reliability, invocations, windows)
    }

    private data class Rig(
        val reliability: ReliabilityModel,
        val invocations: List<ReliabilityModel.ServiceInvocation>,
        val windows: List<ConnectionWindow>,
    )
}
