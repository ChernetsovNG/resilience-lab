package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.OutlierDetectionConfig
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.results.NodeWindow

class OutlierDetectionTest {
    @Test
    fun `consecutive failures eject return and increase duration without leaking across replications`() {
        val rig = simulate(graph(), listOf(0.0, 1.0, 2.0, 10.0, 11.0, 12.0, 13.0, 31.0, 32.0), replications = 2)
        val target = rig.result.services.getValue("a")
        assertThat(target.ejections).isEqualTo(2)
        assertThat(target.ejectedMs).isEqualTo(30.0)
        assertThat(target.offeredAttempts).isEqualTo(5)
        assertThat(rig.result.entries.total.successes).isEqualTo(4)
        assertThat(
            rig.nodes
                .filter { it.id == "a" }
                .takeLast(4)
                .map { it.metrics.ejectedMs },
        ).containsExactly(9.0, 9.0, 10.0, 2.0)
        assertThat(
            rig.nodes
                .filter { it.id == "a" }
                .takeLast(4)
                .sumOf { it.metrics.ejections },
        ).isEqualTo(2)
    }

    @Test
    fun `successful outcomes reset the failure streak and slow successful work is never ejected`() {
        val base = graph().copy(services = graph().services.map { it.copy(failureProbability = 0.0) })
        val faults =
            listOf(
                FaultSpan("a", 0.0, 1.0, FaultKind.ERRORS, failureProbability = 1.0),
                FaultSpan("a", 2.0, 4.0, FaultKind.ERRORS, failureProbability = 1.0),
            )
        val rig = simulate(base.copy(faults = faults), listOf(0.0, 1.0, 2.0, 3.0))
        assertThat(
            rig.result.services
                .getValue("a")
                .ejections,
        ).isEqualTo(1)
        assertThat(
            rig.result.services
                .getValue("a")
                .ejectedMs,
        ).isEqualTo(10.0)
        val slow = base.copy(services = base.services.map { it.copy(processing = TestChains.fixed(20.0)) })
        assertThat(
            simulate(slow, listOf(0.0, 1.0, 2.0))
                .result.services.values
                .sumOf { it.ejections },
        ).isZero()
    }

    @Test
    fun `ejected fraction rounds down and never excludes every distinct target`() {
        for ((fraction, expected) in listOf(0.0 to 0, 0.5 to 1, 1.0 to 2)) {
            val base = graph(OutlierDetectionConfig(1, 100.0, fraction))
            val failing = base.copy(services = base.services.map { it.copy(failureProbability = 1.0) })
            val result = simulate(failing, (0..5).map(Int::toDouble)).result
            assertThat(result.services.values.sumOf { it.ejections }).describedAs("fraction=$fraction").isEqualTo(expected)
            assertThat(result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("error" to 6))
        }
        val one = graph(OutlierDetectionConfig(1, 10.0, 1.0)).let { it.copy(services = it.services.take(1), routes = it.routes.take(1)) }
        assertThat(
            simulate(one, listOf(0.0, 1.0))
                .result.services
                .getValue("a")
                .ejections,
        ).isZero()
    }

    @Test
    fun `attempt timeout ejects immediately and late successful orphan responses do not extend ejection`() {
        val base = graph(OutlierDetectionConfig(1, 10.0, 0.5))
        val caller =
            TestChains
                .simple()
                .services
                .first()
                .copy(processing = TestChains.fixed(0.0), handlers = 10)
        val call =
            TestChains.simple().calls.first().copy(
                from = caller.path,
                to = "router",
                timeoutMs = 5.0,
                attempts = 1,
                network = TestChains.fixed(0.0),
            )
        val routed =
            base.copy(
                clients = listOf(base.client.copy(entry = caller.path)),
                services =
                    listOf(caller) +
                        base.services.map {
                            if (it.path ==
                                "a"
                            ) {
                                it.copy(processing = TestChains.fixed(20.0), failureProbability = 0.0)
                            } else {
                                it
                            }
                        },
                calls = listOf(call),
            )
        val rig = simulate(routed, listOf(0.0, 6.0, 15.0, 21.0))
        assertThat(
            rig.result.services
                .getValue("a")
                .ejections,
        ).isEqualTo(2)
        // The first orphan stays in flight until 20ms, so least-in-flight chooses a again at 21ms, not 15ms.
        assertThat(
            rig.result.services
                .getValue("a")
                .ejectedMs,
        ).isEqualTo(24.0)
        assertThat(rig.result.entries.total.successes).isEqualTo(2)
        assertThat(
            rig.result.connections
                .getValue(call.path)
                .orphaned,
        ).isEqualTo(2)
    }

    @Test
    fun `caller pool rejection and original deadline do not blame an unobserved target`() {
        val base = graph(OutlierDetectionConfig(1, 10.0, 0.5))
        val caller =
            TestChains
                .simple()
                .services
                .first()
                .copy(processing = TestChains.fixed(0.0), handlers = 10)
        val call =
            TestChains.simple().calls.first().copy(
                from = caller.path,
                to = "router",
                timeoutMs = 100.0,
                attempts = 1,
                network = TestChains.fixed(0.0),
                pool = CallPool(1, 0.0),
            )
        val routed =
            base.copy(
                clients = listOf(base.client.copy(entry = caller.path, deadlineMs = 5.0)),
                services = listOf(caller) + base.services.map { it.copy(processing = TestChains.fixed(20.0), failureProbability = 0.0) },
                calls = listOf(call),
            )
        val result = simulate(routed, listOf(0.0, 1.0)).result
        assertThat(result.entries.total.failuresByReason).containsExactlyInAnyOrderEntriesOf(mapOf("waitLimit" to 1, "deadline" to 1))
        assertThat(result.services.values.sumOf { it.ejections }).isZero()
    }

    @Test
    fun `multiple routers sum exclusion time while warmup and runout are clipped`() {
        val base = graph(OutlierDetectionConfig(1, 10.0, 0.5))
        val shared =
            base.copy(
                routers = base.routers + base.routers.single().copy(pathSegments = listOf("other-router")),
                routes = base.routes + base.routes.map { it.copy(pathSegments = listOf("other-${it.path}"), from = "other-router") },
                run = base.run.copy(warmupMs = 5.0, measurementMs = 20.0),
            )
        val rig = simulate(shared, listOf(0.0, 2.0), listOf("router", "other-router"))
        assertThat(
            rig.result.services
                .getValue("a")
                .ejections,
        ).isZero()
        assertThat(
            rig.result.services
                .getValue("a")
                .ejectedMs,
        ).isEqualTo(12.0)
        assertThat(rig.nodes.filter { it.id == "a" }.sumOf { it.metrics.ejectedMs }).isEqualTo(20.0)
        assertThat(rig.nodes.filter { it.id == "a" }.sumOf { it.metrics.ejections }).isEqualTo(2)
    }

    private fun graph(config: OutlierDetectionConfig = OutlierDetectionConfig(2, 10.0, 0.5)): GraphIr {
        val base = TestChains.simple()
        val first = base.services.first()
        return base.copy(
            clients = listOf(base.client.copy(entry = "router", deadlineMs = 100.0)),
            services =
                listOf("a", "b", "c").map {
                    first.copy(
                        pathSegments = listOf(it),
                        handlers = 10,
                        processing = TestChains.fixed(0.0),
                        failureProbability =
                            if (it ==
                                "a"
                            ) {
                                1.0
                            } else {
                                0.0
                            },
                    )
                },
            calls = emptyList(),
            routers = listOf(RouterNode("router", RoutingPolicy.LEAST_IN_FLIGHT, outlierDetection = config)),
            routes = listOf("a", "b", "c").map { RouteEdge("route-$it", "router", it) },
            run = base.run.copy(warmupMs = 0.0, measurementMs = 40.0, windowMs = 10.0),
        )
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double>,
        targets: List<String> =
            List(arrivals.size) {
                graph.entry
            },
        replications: Int = 1,
    ): Rig {
        val model = Model("OutlierDetectionTest", autoCSVReports = false)
        val nodes = mutableListOf<NodeWindow>()
        val reliability =
            ReliabilityModel(model, graph, PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0), onWindow = {
                _,
                rows,
                _,
                ->
                nodes +=
                    rows
            })
        object : ProcessModel(model, name = "outlier-driver") {
            override fun initialize() {
                arrivals.forEachIndexed { index, arrival ->
                    reliability.invoke(
                        targets[index],
                        arrival,
                        originalRequest = true,
                        measurementCohort =
                            arrival >= graph.run.warmupMs && arrival < graph.run.warmupMs + graph.run.measurementMs,
                    )
                }
            }
        }
        model.numberOfReplications = replications
        model.lengthOfReplication = 1_000.0
        model.simulate()
        reliability.metrics.verifyConnectionsDrained()
        return Rig(reliability.metrics.replicationResult(), nodes)
    }

    private data class Rig(
        val result: ReplicationResult,
        val nodes: List<NodeWindow>,
    )
}
