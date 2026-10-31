package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import org.junit.jupiter.api.Test
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.math.sqrt

class RequestClassesTest {
    @Test
    fun `processing and nested retries inherit the original class client and timing`() {
        val base = graph()
        val graph =
            base.copy(
                services =
                    listOf(
                        service(
                            "entry",
                            listOf(
                                ServiceStep.Process(TestChains.fixed(2.0), classes = setOf("status")),
                                ServiceStep.Process(TestChains.fixed(100.0), 1.0, setOf("checkout")),
                                ServiceStep.Call("entry-middle", setOf("status")),
                                ServiceStep.Call("entry-skipped", setOf("checkout")),
                                ServiceStep.Process(TestChains.fixed(3.0), classes = setOf("status")),
                            ),
                        ),
                        service(
                            "middle",
                            listOf(
                                ServiceStep.Process(TestChains.fixed(4.0), classes = setOf("status")),
                                ServiceStep.Call("middle-leaf", setOf("status")),
                                ServiceStep.Process(TestChains.fixed(100.0), 1.0, setOf("checkout")),
                            ),
                        ),
                        service("broken").copy(processing = TestChains.fixed(5.0), failureProbability = 1.0),
                        service(
                            "leaf",
                            listOf(
                                ServiceStep.Process(TestChains.fixed(5.0), classes = setOf("status")),
                                ServiceStep.Process(TestChains.fixed(100.0), 1.0, setOf("checkout")),
                            ),
                        ),
                        service("skipped"),
                    ),
                calls =
                    listOf(
                        call("entry-middle", "entry", "middle"),
                        call("middle-leaf", "middle", "leaf").copy(attempts = 2),
                        call("entry-skipped", "entry", "skipped"),
                    ),
                routers = emptyList(),
                routes = emptyList(),
            )
        val rig =
            simulate(graph, selectTarget = { edge, attempt ->
                if (edge.path == "middle-leaf" && attempt == 1) "broken" else edge.to
            })
        val original = rig.invocations.single()
        assertThat(original.outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
        val middle = original.callAttempt!!.child
        val leaf = middle.callAttempt!!.child
        assertThat(original.work.processCompletionTime).isEqualTo(26.0)
        assertThat(original.request).isEqualTo(RequestContext("mobile", "status", 7.0, 507.0))
        assertThat(middle.request).isSameAs(original.request)
        assertThat(leaf.request).isSameAs(original.request)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(result.connections.getValue("middle-leaf").sentAttempts).isEqualTo(2)
        assertThat(result.connections.getValue("entry-skipped").sentAttempts).isZero()
        assertDrained(rig.reliability)
    }

    @Test
    fun `clients sharing an entry keep their own deadline`() {
        val base = graph()
        val short = base.clients.single().copy(deadlineMs = 5.0)
        val long = short.copy(pathSegments = listOf("partner"), deadlineMs = 100.0)
        val graph =
            base.copy(
                clients = listOf(long, short),
                services = listOf(service("entry").copy(processing = TestChains.fixed(20.0))),
                calls = emptyList(),
                routers = emptyList(),
                routes = emptyList(),
            )
        val rig = simulate(graph, listOf(Arrival(short), Arrival(long)))

        assertThat(rig.invocations.map { it.outcome }).containsExactly(AttemptOutcome.DEADLINE_EXCEEDED, AttemptOutcome.SUCCEEDED)
        assertThat(rig.invocations.map { it.request.deadlineMs }).containsExactly(12.0, 107.0)
        val result = rig.reliability.metrics.replicationResult()
        assertThat(result.originalArrivals).isEqualTo(2)
        assertThat(result.successes).isEqualTo(1)
        assertThat(result.failures).isEqualTo(1)
        assertThat(result.allLatency.sumMs).isEqualTo(25.0)
        assertDrained(rig.reliability)
    }

    @Test
    fun `every routing policy and other retries stay within the request class after exhausting outputs`() {
        for (policy in RoutingPolicy.entries) {
            val base = graph(policy)
            val failing =
                base.copy(
                    services = base.services.map { if (it.path in setOf("a", "b")) it.copy(failureProbability = 1.0) else it },
                    calls = base.calls.map { it.copy(attempts = 5, retryTarget = RetryTarget.OTHER) },
                )
            val rig = simulate(failing)
            val connections =
                rig.reliability.metrics
                    .replicationResult()
                    .connections

            assertThat(rig.invocations.single().outcome).describedAs("%s", policy).isEqualTo(AttemptOutcome.DOWNSTREAM_FAILURE)
            assertThat(connections.getValue("route-a").sentAttempts).isPositive()
            assertThat(connections.getValue("route-b").sentAttempts).isPositive()
            assertThat(connections.getValue("route-a").sentAttempts + connections.getValue("route-b").sentAttempts).isEqualTo(5)
            assertThat(connections.getValue("route-c").sentAttempts).isZero()
            assertDrained(rig.reliability)

            val checkout = simulate(failing, listOf(Arrival(failing.clients.single(), "checkout")))
            assertThat(checkout.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
            assertThat(
                checkout.reliability.metrics
                    .replicationResult()
                    .connections
                    .getValue("route-c")
                    .sentAttempts,
            ).isEqualTo(1)
            assertDrained(checkout.reliability)
        }
    }

    @Test
    fun `missing route returns noRoute for every attempt and releases partially selected routes`() {
        val base = missingRouteGraph()
        val graph = base.copy(calls = base.calls.map { it.copy(attempts = 3) })
        val rig = simulate(graph)
        val original = rig.invocations.single()
        val connections =
            rig.reliability.metrics
                .replicationResult()
                .connections

        assertThat(original.outcome.name).isEqualTo("NO_ROUTE")
        assertThat(original.callAttempt!!.status.name).isEqualTo("NO_ROUTE")
        assertThat(
            original.callAttempt!!
                .child.outcome.name,
        ).isEqualTo("NO_ROUTE")
        assertThat(original.work.processCompletionTime).isEqualTo(7.0)
        assertThat(connections.getValue("call").sentAttempts).isEqualTo(3)
        assertThat(connections.getValue("call").failed).isEqualTo(3)
        assertThat(connections.getValue("call").retries).isEqualTo(2)
        assertThat(connections.getValue("outer").sentAttempts).isEqualTo(3)
        assertThat(connections.getValue("outer").failed).isEqualTo(3)
        assertThat(connections.getValue("inner").sentAttempts).isZero()
        assertDrained(rig.reliability)
    }

    @Test
    fun `original request without a route is counted and finishes immediately without service work`() {
        val base = missingRouteGraph()
        val graph = base.copy(clients = listOf(base.clients.single().copy(entry = "router")), calls = emptyList())
        val rig = simulate(graph)
        val result = rig.reliability.metrics.replicationResult()

        assertThat(
            rig.invocations
                .single()
                .outcome.name,
        ).isEqualTo("NO_ROUTE")
        assertThat(
            rig.invocations
                .single()
                .work.processCompletionTime,
        ).isEqualTo(7.0)
        assertThat(result.originalArrivals).isEqualTo(1)
        assertThat(result.failures).isEqualTo(1)
        assertThat(result.allLatency.sumMs).isZero()
        assertThat(result.services.values.sumOf { it.offeredAttempts }).isZero()
        assertThat(result.connections.getValue("outer").failed).isEqualTo(1)
        assertThat(result.connections.getValue("inner").sentAttempts).isZero()
        assertDrained(rig.reliability)
    }

    @Test
    fun `each class follows its own profile in service windows`() {
        val step = LoadProfile(listOf(LoadPoint(0.0, 0.5), LoadPoint(1_999.999, 0.5), LoadPoint(2_000.0, 1.5)))
        val ramp = LoadProfile(listOf(LoadPoint(0.0, 0.0), LoadPoint(4_000.0, 2.0)))
        val base = graph()
        val graph =
            base.copy(
                clients = listOf(base.clients.single().copy(classes = mapOf("status" to step, "checkout" to ramp))),
                routes = base.routes.filter { it.path != "route-b" },
                run = base.run.copy(measurementMs = 4_000.0, windowMs = 1_000.0),
            )
        val counts = mutableMapOf<Pair<String, Int>, Int>()
        repeat(8) { replication ->
            val model = Model("ClassProfiles", autoCSVReports = false)
            val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, replication)), graph.run.seed, replication.toLong())
            ReliabilityModel(
                model,
                graph,
                streams,
                onWindow = { _, rows, _ ->
                    rows.filter { it.id in setOf("a", "c") }.forEach { row ->
                        val key = row.id to (row.metrics.startMs / 1_000.0).toInt()
                        counts[key] = counts.getOrDefault(key, 0) + row.metrics.offeredAttempts
                    }
                },
            ).runReplication()
        }

        mapOf("a" to listOf(500.0, 500.0, 1_500.0, 1_500.0), "c" to listOf(250.0, 750.0, 1_250.0, 1_750.0))
            .forEach { (service, expected) ->
                expected.forEachIndexed { window, count ->
                    assertThat(counts.getValue(service to window).toDouble())
                        .describedAs("%s window %s", service, window)
                        .isCloseTo(count * 8, offset(6 * sqrt(count * 8)))
                }
            }
    }

    private fun graph(policy: RoutingPolicy = RoutingPolicy.ROUND_ROBIN): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            clients =
                listOf(
                    ClientNode(
                        listOf("mobile"),
                        mapOf("status" to LoadProfile.constant(0.0), "checkout" to LoadProfile.constant(0.0)),
                        500.0,
                        "entry",
                    ),
                ),
            services = listOf("entry", "a", "b", "c").map { service(it) },
            calls = listOf(call("call", "entry", "router")),
            routers = listOf(RouterNode("router", policy)),
            routes =
                listOf(
                    RouteEdge(listOf("route-a"), "router", "a", classes = setOf("status")),
                    RouteEdge(listOf("route-b"), "router", "b", classes = setOf("status")),
                    RouteEdge(listOf("route-c"), "router", "c", classes = setOf("checkout")),
                ),
            run = base.run.copy(measurementMs = 100.0, windowMs = 10.0),
        )
    }

    private fun missingRouteGraph(): GraphIr {
        val base = graph()
        return base.copy(
            routers = base.routers + RouterNode("nested", RoutingPolicy.ROUND_ROBIN),
            routes =
                listOf(
                    RouteEdge(listOf("outer"), "router", "nested", classes = setOf("status")),
                    RouteEdge(listOf("inner"), "nested", "a", classes = setOf("checkout")),
                ),
        )
    }

    private fun service(
        id: String,
        steps: List<ServiceStep>? = null,
    ) = ServiceNode(id, 100, 0, TestChains.fixed(0.0), 0.0, scenario = steps)

    private fun call(
        id: String,
        from: String,
        to: String,
    ) = CallEdge(id, from, to, TestChains.fixed(0.0), 100.0, 1, TestChains.noBackoff)

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Arrival> = listOf(Arrival(graph.clients.first())),
        selectTarget: (CallEdge, Int) -> String = { edge, _ -> edge.to },
    ): Rig {
        val model = Model("RequestClasses", autoCSVReports = false)
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(model, graph, streams, selectTarget = selectTarget)
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(model, name = "classes-driver") {
            override fun initialize() {
                arrivals.forEach { arrival ->
                    invocations +=
                        reliability.invoke(
                            arrival.client.entry,
                            arrival.atMs,
                            originalRequest = true,
                            client = arrival.client,
                            requestClass = arrival.requestClass,
                        )
                }
            }
        }
        model.numberOfReplications = 1
        model.lengthOfReplication = 1_000.0
        model.simulate()
        return Rig(reliability, invocations)
    }

    private fun assertDrained(reliability: ReliabilityModel) {
        assertThat(reliability.activeOriginalRequests).isZero()
        assertThat(reliability.activeInvocations).isZero()
        assertThat(reliability.activeDownstreamProcesses).isZero()
        reliability.metrics.verifyConnectionsDrained()
    }

    private data class Arrival(
        val client: ClientNode,
        val requestClass: String = "status",
        val atMs: Double = 7.0,
    )

    private data class Rig(
        val reliability: ReliabilityModel,
        val invocations: List<ReliabilityModel.ServiceInvocation>,
    )
}
