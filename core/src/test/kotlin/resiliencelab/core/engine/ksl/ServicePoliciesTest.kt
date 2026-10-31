package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.HealthCheckConfig
import resiliencelab.core.ir.RateLimitConfig
import resiliencelab.core.ir.RetryTarget
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.results.NodeWindow

class ServicePoliciesTest {
    @Test
    fun `readiness requires consecutive outcomes and resets the opposite streak`() {
        val changes = mutableListOf<Boolean>()
        val health = ServiceHealth(HealthCheckConfig(5.0, 1.0, 2, 2, 0.0), changes::add)
        health.complete(false)
        assertThat(health.ready).isTrue()
        health.complete(true)
        health.complete(false)
        assertThat(health.ready).isTrue()
        health.complete(false)
        assertThat(health.ready).isFalse()
        health.complete(true)
        health.complete(false)
        health.complete(true)
        assertThat(health.ready).isFalse()
        health.complete(true)
        assertThat(health.ready).isTrue()
        assertThat(changes).containsExactly(false, true)
        health.reset()
        health.complete(false)
        assertThat(health.ready).isTrue()
    }

    @Test
    fun `bucket admits the burst and replenishes continuously before queue admission`() {
        val base = graph()
        val limited = base.copy(services = base.services.map { it.copy(rateLimit = RateLimitConfig(0.1, 2)) })
        val rig = simulate(limited, listOf(0.0, 0.0, 0.0, 5.0, 10.0, 20.0, 20.0))
        val service = rig.result.services.getValue("entry")
        assertThat(service.offeredAttempts).isEqualTo(7)
        assertThat(service.admittedAttempts).isEqualTo(4)
        assertThat(service.rateLimited).isEqualTo(3)
        assertThat(service.failuresByReason).containsExactlyEntriesOf(mapOf("rateLimited" to 3))
        assertThat(service.slotPools.getValue("handlers").busyIntegralMs).isEqualTo(16.0)
        assertThat(service.slotPools.getValue("handlers").queueFullCount).isZero()
        assertThat(rig.result.entries.total.successes).isEqualTo(4)
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("rateLimited" to 3))
        assertThat(rig.serviceWindows.map { it.metrics.rateLimited }).containsExactly(2, 0, 1, 0)
    }

    @Test
    fun `buckets belong to individual instances and reset each replication`() {
        val base = graph()
        val first = base.services.single().copy(rateLimit = RateLimitConfig(0.0, 1))
        val second = first.copy(pathSegments = listOf("other"))
        val rig =
            simulate(
                base.copy(services = listOf(first, second)),
                listOf(0.0, 0.0, 1.0, 1.0),
                listOf("entry", "other", "entry", "other"),
                replications = 2,
            )
        assertThat(
            rig.result.services.values
                .map { it.admittedAttempts },
        ).containsExactly(1, 1)
        assertThat(
            rig.result.services.values
                .map { it.rateLimited },
        ).containsExactly(1, 1)
        assertThat(rig.result.entries.total.successes).isEqualTo(2)
    }

    @Test
    fun `queued probes fail under overload then restore readiness after consecutive successes`() {
        val rig = simulate(overloaded(), listOf(0.0, 8.0), listOf("router", "router"))
        val service = rig.result.services.getValue("entry")
        assertThat(rig.result.entries.total.originalArrivals).isEqualTo(2)
        assertThat(rig.result.entries.total.successes).isEqualTo(1)
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("noReadyTarget" to 1))
        assertThat(service.offeredAttempts).isEqualTo(1)
        assertThat(service.admittedAttempts).isEqualTo(1)
        assertThat(service.latency.count).isEqualTo(1)
        assertThat(service.probes).isEqualTo(6)
        assertThat(service.probeFailures).isEqualTo(3)
        assertThat(service.notReadyMs).isEqualTo(19.0)
        assertThat(service.slotPools.getValue("handlers").busyIntegralMs).isEqualTo(23.0)
        assertThat(rig.serviceWindows.map { it.metrics.notReadyMs }).containsExactly(3.0, 10.0, 6.0, 0.0)
        assertThat(rig.serviceWindows.sumOf { it.metrics.probes }).isEqualTo(6)
        assertThat(rig.serviceWindows.sumOf { it.metrics.probeFailures }).isEqualTo(3)
    }

    @Test
    fun `readiness is shared by every router targeting an instance`() {
        val base = overloaded()
        val shared =
            base.copy(
                routers = base.routers + RouterNode("other-router", RoutingPolicy.ROUND_ROBIN),
                routes = base.routes + RouteEdge("other-route", "other-router", "entry"),
            )
        val rig = simulate(shared, listOf(0.0, 8.0, 9.0), listOf("router", "router", "other-router"))
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("noReadyTarget" to 2))
        assertThat(
            rig.result.services
                .getValue("entry")
                .offeredAttempts,
        ).isEqualTo(1)
    }

    @Test
    fun `probe timeouts do not release admitted processing early or enter the request cohort`() {
        val base = graph()
        val checked =
            base.copy(
                services =
                    base.services.map {
                        it.copy(
                            handlers = 1,
                            processing = TestChains.fixed(1.0),
                            healthCheck = HealthCheckConfig(10.0, 2.0, 1, 1, 5.0),
                        )
                    },
                run = base.run.copy(measurementMs = 30.0),
            )
        val rig = simulate(checked, listOf(13.0))
        val service = rig.result.services.getValue("entry")
        assertThat(rig.result.entries.total.originalArrivals).isEqualTo(1)
        assertThat(rig.result.entries.total.allLatency.sumMs).isEqualTo(3.0)
        assertThat(service.admittedAttempts).isEqualTo(1)
        assertThat(service.probes).isEqualTo(2)
        assertThat(service.probeFailures).isEqualTo(2)
        assertThat(service.notReadyMs).isEqualTo(18.0)
        assertThat(service.slotPools.getValue("handlers").busyIntegralMs).isEqualTo(11.0)
        assertThat(service.slotPools.getValue("handlers").waitCount).isEqualTo(1)
    }

    @Test
    fun `probes bypass rate limiting`() {
        val base = graph()
        val checked =
            base.copy(
                services =
                    base.services.map {
                        it.copy(rateLimit = RateLimitConfig(0.0, 1), healthCheck = HealthCheckConfig(5.0, 2.0, 1, 1, 0.0))
                    },
            )
        val rig = simulate(checked, listOf(0.0, 10.0))
        val service = rig.result.services.getValue("entry")
        assertThat(service.rateLimited).isEqualTo(1)
        assertThat(service.probes).isEqualTo(7)
        assertThat(service.probeFailures).isZero()
        assertThat(service.notReadyMs).isZero()
        assertThat(rig.result.entries.total.successes).isEqualTo(1)
    }

    @Test
    fun `zero cost probes leave request outcomes and their random streams unchanged`() {
        val base = graph().let { it.copy(services = it.services.map { node -> node.copy(failureProbability = 0.4) }) }
        val checked = base.copy(services = base.services.map { it.copy(healthCheck = HealthCheckConfig(1.0, 10.0, 1, 1, 0.0)) })
        val arrivals = (0..9).map { it * 3.0 }
        assertThat(simulate(checked, arrivals).result.entries).isEqualTo(simulate(base, arrivals).result.entries)
    }

    @Test
    fun `full probe queues affect only probe failures`() {
        val base = graph()
        val checked =
            base.copy(
                services =
                    base.services.map {
                        it.copy(
                            handlers = 1,
                            queueCapacity = 0,
                            processing = TestChains.fixed(5.0),
                            healthCheck = HealthCheckConfig(1.0, 2.0, 1, 1, 0.1),
                        )
                    },
                run = base.run.copy(measurementMs = 10.0),
            )
        val rig = simulate(checked, listOf(0.0))
        val service = rig.result.services.getValue("entry")
        assertThat(service.probes).isEqualTo(9)
        assertThat(service.probeFailures).isEqualTo(4)
        assertThat(service.failuresByReason).isEmpty()
        assertThat(service.slotPools.getValue("handlers").queueFullCount).isZero()
        assertThat(service.offeredAttempts).isEqualTo(1)
        assertThat(rig.result.entries.total.successes).isEqualTo(1)
    }

    @Test
    fun `readiness starts ready again in each replication`() {
        val base = overloaded()
        val checked = base.copy(services = base.services.map { it.copy(healthCheck = HealthCheckConfig(5.0, 1.0, 1, 1, 2.0)) })
        val rig = simulate(checked, listOf(0.0), listOf("router"), replications = 2)
        assertThat(rig.result.entries.total.successes).isEqualTo(1)
        assertThat(rig.result.entries.total.failuresByReason).isEmpty()
        assertThat(
            rig.result.services
                .getValue("entry")
                .offeredAttempts,
        ).isEqualTo(1)
    }

    @Test
    fun `downstream no ready target keeps its reason through the call and original`() {
        val base = TestChains.simple()
        val checked =
            base.copy(
                services =
                    listOf(
                        base.services.first().copy(handlers = 10, processing = TestChains.fixed(0.0)),
                        base.services.last().copy(handlers = 1, healthCheck = HealthCheckConfig(5.0, 2.0, 1, 2, 1.0)),
                    ),
                calls = base.calls.map { it.copy(to = "router", attempts = 1) },
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf(RouteEdge("route", "router", "backend")),
                run = base.run.copy(measurementMs = 35.0, windowMs = 10.0),
            )
        val rig = simulate(checked, listOf(0.0, 8.0))
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("noReadyTarget" to 1))
        assertThat(
            rig.result.connections
                .getValue("entry-to-backend")
                .failuresByReason,
        ).containsExactlyEntriesOf(mapOf("noReadyTarget" to 1))
        assertThat(
            rig.result.services
                .getValue("entry")
                .failuresByReason,
        ).containsExactlyEntriesOf(mapOf("noReadyTarget" to 1))
    }

    @Test
    fun `every balancing policy and other retries exclude not ready instances`() {
        for (policy in RoutingPolicy.entries) {
            val base = TestChains.simple()
            val checked =
                base.copy(
                    services =
                        listOf(
                            base.services.first().copy(handlers = 10, processing = TestChains.fixed(0.0)),
                            base.services.last().copy(handlers = 1, healthCheck = HealthCheckConfig(5.0, 2.0, 1, 1, 1.0)),
                            base.services.last().copy(
                                pathSegments = listOf("other"),
                                processing = TestChains.fixed(0.0),
                                failureProbability = 1.0,
                            ),
                        ),
                    calls = base.calls.map { it.copy(to = "router", attempts = 2, retryTarget = RetryTarget.OTHER) },
                    routers = listOf(RouterNode("router", policy)),
                    routes = listOf(RouteEdge("route", "router", "backend"), RouteEdge("other-route", "router", "other")),
                    run = base.run.copy(measurementMs = 35.0, windowMs = 10.0),
                )
            val rig = simulate(checked, listOf(0.0, 8.0), listOf("backend", "entry"))
            assertThat(
                rig.result.services
                    .getValue("backend")
                    .offeredAttempts,
            ).describedAs(policy.name).isEqualTo(1)
            assertThat(
                rig.result.services
                    .getValue("other")
                    .offeredAttempts,
            ).describedAs(policy.name).isEqualTo(2)
        }
    }

    @Test
    fun `aggressive checks cascade across replicas under a burst`() {
        val base = graph()
        val template = base.services.single().copy(handlers = 1, queueCapacity = 100, processing = TestChains.fixed(2.5))
        val checked =
            base.copy(
                services =
                    listOf(
                        template.copy(
                            pathSegments = listOf("a"),
                            processing = TestChains.fixed(20.0),
                            healthCheck = HealthCheckConfig(5.0, 1.0, 1, 1, 0.1),
                        ),
                        template.copy(pathSegments = listOf("b"), healthCheck = HealthCheckConfig(10.0, 1.0, 1, 1, 0.1)),
                        template.copy(pathSegments = listOf("c"), healthCheck = HealthCheckConfig(11.0, 1.0, 1, 1, 0.1)),
                    ),
                clients = listOf(base.client.copy(entry = "router")),
                routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf("a", "b", "c").map { RouteEdge("route-$it", "router", it) },
                run = base.run.copy(windowMs = 1.0),
            )
        val arrivals = (0..39).map(Int::toDouble)
        val rig = simulate(checked, arrivals)
        val firstNotReady =
            rig.nodes
                .filter { it.metrics.notReadyMs > 0.0 }
                .groupBy { it.id }
                .mapValues { (_, rows) -> rows.first().metrics.startMs }
        assertThat(firstNotReady.keys).containsExactlyInAnyOrder("a", "b", "c")
        assertThat(firstNotReady.getValue("a")).isLessThan(firstNotReady.getValue("b"))
        assertThat(firstNotReady.getValue("b")).isLessThan(firstNotReady.getValue("c"))
        assertThat(
            rig.result.entries.total.failuresByReason
                .getValue("noReadyTarget"),
        ).isPositive()
        val without = simulate(checked.copy(services = checked.services.map { it.copy(healthCheck = null) }), arrivals)
        assertThat(without.result.entries.total.successes).isEqualTo(40)
        assertThat(rig.result.entries.total.successes).isLessThan(40)
        assertThat(rig.result.entries.total.successes).isEqualTo(27)
        assertThat(rig.result.entries.total.failuresByReason).containsExactlyEntriesOf(mapOf("noReadyTarget" to 13))
    }

    @Test
    fun `warmup readiness carries into measurement but its duration and probes are clipped`() {
        val base = overloaded()
        val rig = simulate(base.copy(run = base.run.copy(warmupMs = 10.0, measurementMs = 25.0)), listOf(0.0))
        val service = rig.result.services.getValue("entry")
        assertThat(rig.result.entries.total.originalArrivals).isZero()
        assertThat(service.offeredAttempts).isZero()
        assertThat(service.probes).isEqualTo(5)
        assertThat(service.probeFailures).isEqualTo(2)
        assertThat(service.notReadyMs).isEqualTo(16.0)
        assertThat(rig.serviceWindows.sumOf { it.metrics.notReadyMs }).isEqualTo(19.0)
    }

    private fun graph(): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services = listOf(base.services.first().copy(handlers = 10, queueCapacity = 10, processing = TestChains.fixed(4.0))),
            calls = emptyList(),
            run = base.run.copy(measurementMs = 40.0, windowMs = 10.0),
        )
    }

    private fun overloaded(): GraphIr {
        val base = graph()
        return base.copy(
            services =
                base.services.map {
                    it.copy(handlers = 1, processing = TestChains.fixed(20.0), healthCheck = HealthCheckConfig(5.0, 2.0, 1, 2, 1.0))
                },
            routers = listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
            routes = listOf(RouteEdge("route", "router", "entry")),
            run = base.run.copy(measurementMs = 35.0),
        )
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double>,
        targets: List<String> = List(arrivals.size) { graph.entry },
        replications: Int = 1,
    ): Rig {
        val model = Model("ServicePoliciesTest", autoCSVReports = false)
        val nodes = mutableListOf<NodeWindow>()
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(model, graph, streams, onWindow = { _, rows, _ -> nodes += rows })
        object : ProcessModel(model, name = "service-policy-driver") {
            override fun initialize() {
                arrivals.forEachIndexed { index, arrival ->
                    reliability.invoke(targets[index], arrival, originalRequest = true, measurementCohort = arrival >= graph.run.warmupMs)
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
    ) {
        val serviceWindows: List<NodeWindow> get() = nodes.filter { it.id == "entry" }
    }
}
