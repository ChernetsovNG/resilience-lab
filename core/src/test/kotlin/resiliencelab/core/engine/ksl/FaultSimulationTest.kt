package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.PoolerSettings
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import kotlin.test.Test

class FaultSimulationTest {
    @Test
    fun `overlapping slowdowns multiply and restore at half open boundaries`() {
        val base = TestChains.simple()
        val graph =
            base.copy(
                services = listOf(base.services.first().copy(handlers = 10, processing = TestChains.fixed(2.0))),
                calls = emptyList(),
                faults =
                    listOf(
                        FaultSpan("entry", 10.0, 30.0, FaultKind.SLOWDOWN, multiplier = 2.0),
                        FaultSpan("entry", 20.0, 40.0, FaultKind.SLOWDOWN, multiplier = 3.0),
                    ),
            )
        val rig = simulate(graph, listOf(9.0, 10.0, 20.0, 30.0, 40.0))
        assertThat(rig.completions).containsExactly(11.0, 14.0, 32.0, 36.0, 42.0)
    }

    @Test
    fun `slowdowns add durations after multiplying the sampled node duration`() {
        val base = graph()
        val rig =
            simulate(
                base.copy(
                    faults =
                        listOf(
                            FaultSpan("backend", 10.0, 20.0, FaultKind.SLOWDOWN, multiplier = 3.0, delayMs = 4.0),
                            FaultSpan("backend", 10.0, 20.0, FaultKind.SLOWDOWN, delayMs = 2.0),
                        ),
                ),
                listOf(9.0, 10.0, 20.0),
            )
        assertThat(rig.completions).containsExactly(11.0, 22.0, 22.0)
    }

    @Test
    fun `call and route slowdowns affect transmission at its own start including the return trip`() {
        for (target in listOf("entry-to-backend", "route")) {
            val base = graph(routed = target == "route")
            val rig =
                simulate(
                    base.copy(
                        services = base.services.map { if (it.path == "backend") it.copy(processing = TestChains.fixed(5.0)) else it },
                        calls = base.calls.map { it.copy(network = TestChains.fixed(1.0)) },
                        faults = listOf(FaultSpan(target, 0.0, 5.0, FaultKind.SLOWDOWN, multiplier = 2.0)),
                    ),
                    listOf(0.0, 5.0),
                )
            assertThat(rig.completions).describedAs(target).containsExactly(8.0, 12.0)
        }
    }

    @Test
    fun `node call and route fast unavailability observes interval boundaries without target admission`() {
        for (target in listOf("backend", "entry-to-backend", "route")) {
            val base = graph(routed = target == "route")
            val rig =
                simulate(
                    base.copy(faults = listOf(FaultSpan(target, 10.0, 20.0, FaultKind.UNAVAILABLE))),
                    listOf(9.0, 10.0, 20.0),
                )
            assertThat(rig.completions).describedAs(target).containsExactly(11.0, 10.0, 22.0)
            assertThat(rig.outcomes).containsExactly(AttemptOutcome.SUCCEEDED, AttemptOutcome.DOWNSTREAM_FAILURE, AttemptOutcome.SUCCEEDED)
            assertThat(
                rig.result.services
                    .getValue("backend")
                    .offeredAttempts,
            ).isEqualTo(2)
        }
    }

    @Test
    fun `blackholes on node call and route wait for timeout without work or orphaned allocations`() {
        for (target in listOf("backend", "entry-to-backend", "route")) {
            val base = graph(routed = target == "route")
            val rig =
                simulate(
                    base.copy(
                        calls = base.calls.map { it.copy(timeoutMs = 5.0) },
                        faults = listOf(FaultSpan(target, 10.0, 20.0, FaultKind.BLACKHOLE)),
                    ),
                    listOf(9.0, 10.0, 20.0),
                )
            assertThat(rig.completions).describedAs(target).containsExactly(11.0, 15.0, 22.0)
            assertThat(rig.outcomes).containsExactly(AttemptOutcome.SUCCEEDED, AttemptOutcome.TIMED_OUT, AttemptOutcome.SUCCEEDED)
            assertThat(
                rig.result.services
                    .getValue("backend")
                    .offeredAttempts,
            ).isEqualTo(2)
            assertThat(
                rig.result.connections
                    .getValue("entry-to-backend")
                    .timeouts,
            ).isEqualTo(1)
            assertThat(
                rig.result.connections
                    .getValue("entry-to-backend")
                    .orphanedIntegralMs,
            ).isZero()
        }
    }

    @Test
    fun `entry blackhole waits for original deadline and fast unavailability fails immediately`() {
        for (kind in listOf(FaultKind.BLACKHOLE, FaultKind.UNAVAILABLE)) {
            val base = graph()
            val rig =
                simulate(
                    base.copy(
                        client = base.client.copy(deadlineMs = 5.0),
                        faults = listOf(FaultSpan("entry", 10.0, 20.0, kind)),
                    ),
                    listOf(9.0, 10.0, 20.0),
                )
            assertThat(rig.completions).containsExactly(11.0, if (kind == FaultKind.BLACKHOLE) 15.0 else 10.0, 22.0)
            assertThat(rig.result.originalArrivals).isEqualTo(3)
            assertThat(rig.result.failures).isEqualTo(1)
        }
    }

    @Test
    fun `error faults on nodes calls and routes observe interval boundaries`() {
        for (target in listOf("backend", "entry-to-backend", "route")) {
            val base = graph(routed = target == "route")
            val rig =
                simulate(
                    base.copy(
                        faults =
                            listOf(
                                FaultSpan(target, 10.0, 20.0, FaultKind.ERRORS, failureProbability = 1.0),
                            ),
                    ),
                    listOf(9.0, 10.0, 20.0),
                )
            assertThat(rig.outcomes)
                .describedAs(target)
                .containsExactly(AttemptOutcome.SUCCEEDED, AttemptOutcome.DOWNSTREAM_FAILURE, AttemptOutcome.SUCCEEDED)
            assertThat(
                rig.result.services
                    .getValue("backend")
                    .admittedAttempts,
            ).isEqualTo(if (target == "backend") 3 else 2)
        }
    }

    @Test
    fun `identical error faults combine independently and both expire`() {
        val fault = FaultSpan("backend", 10.0, 20.0, FaultKind.ERRORS, failureProbability = 0.5)
        val base = graph()
        val rig =
            simulate(
                base.copy(
                    services = base.services.map { it.copy(processing = TestChains.fixed(0.0)) },
                    faults = listOf(fault, fault),
                ),
                (0 until 50).map { 10.0 + it * 0.1 } + 20.0,
            )
        val stream = TestChains.stream(base.run.seed, "backend", StreamRole.OUTCOME)
        val expectedFailures = (0 until 50).count { stream.randU01() < 0.75 }
        assertThat(
            rig.result.services
                .getValue("backend")
                .failures,
        ).isEqualTo(expectedFailures)
        assertThat(rig.outcomes.last()).isEqualTo(AttemptOutcome.SUCCEEDED)
    }

    @Test
    fun `capacity loss to zero preserves active work and restores queued work on nodes and call pools`() {
        for (target in listOf("backend", "entry-to-backend")) {
            val base = graph()
            val rig =
                simulate(
                    base.copy(
                        services =
                            base.services.map {
                                if (it.path ==
                                    "backend"
                                ) {
                                    it.copy(handlers = 2, processing = TestChains.fixed(5.0))
                                } else {
                                    it
                                }
                            },
                        calls = base.calls.map { if (target == it.path) it.copy(pool = CallPool(2, 100.0)) else it },
                        faults = listOf(FaultSpan(target, 10.0, 20.0, FaultKind.CAPACITY_LOSS, capacity = 0)),
                    ),
                    listOf(9.0, 10.0, 11.0, 20.0),
                )
            assertThat(rig.completions).describedAs(target).containsExactly(14.0, 25.0, 25.0, 30.0)
            assertThat(rig.outcomes).containsOnly(AttemptOutcome.SUCCEEDED)
        }
    }

    @Test
    fun `overlapping capacity loss uses minimum until the last interval ends`() {
        val base = graph()
        val rig =
            simulate(
                base.copy(
                    services =
                        base.services.map {
                            if (it.path ==
                                "backend"
                            ) {
                                it.copy(handlers = 3, processing = TestChains.fixed(5.0))
                            } else {
                                it
                            }
                        },
                    faults =
                        listOf(
                            FaultSpan("backend", 10.0, 30.0, FaultKind.CAPACITY_LOSS, capacity = 1),
                            FaultSpan("backend", 20.0, 40.0, FaultKind.CAPACITY_LOSS, capacity = 0),
                        ),
                ),
                listOf(9.0, 10.0, 20.0, 30.0, 40.0),
            )
        assertThat(rig.completions).containsExactly(14.0, 19.0, 45.0, 45.0, 45.0)
    }

    @Test
    fun `pooler capacity loss affects server slots while client admissions continue`() {
        val base = graph()
        val downstream = base.calls.single().copy(pathSegments = listOf("query"), from = "backend", to = "database")
        val rig =
            simulate(
                base.copy(
                    services =
                        base.services.map {
                            if (it.path ==
                                "backend"
                            ) {
                                it.copy(processing = TestChains.fixed(0.0), pooler = PoolerSettings(2, 100.0))
                            } else {
                                it
                            }
                        } +
                            base.services.last().copy(pathSegments = listOf("database"), processing = TestChains.fixed(5.0)),
                    calls = base.calls + downstream,
                    faults = listOf(FaultSpan("backend", 10.0, 20.0, FaultKind.CAPACITY_LOSS, capacity = 0)),
                ),
                listOf(9.0, 10.0, 11.0, 20.0),
            )
        assertThat(rig.completions).containsExactly(14.0, 25.0, 25.0, 30.0)
        assertThat(
            rig.result.poolers
                .getValue("backend")
                .admittedAttempts,
        ).isEqualTo(4)
    }

    @Test
    fun `blackhole holds a call connection until timeout and releases it to the next caller`() {
        val base = graph()
        val rig =
            simulate(
                base.copy(
                    calls = base.calls.map { it.copy(timeoutMs = 5.0, pool = CallPool(1, 100.0)) },
                    faults = listOf(FaultSpan("entry-to-backend", 0.0, 10.0, FaultKind.BLACKHOLE)),
                ),
                listOf(0.0, 1.0, 10.0),
            )
        assertThat(rig.completions).containsExactly(5.0, 10.0, 12.0)
        val connection = rig.result.connections.getValue("entry-to-backend")
        assertThat(connection.slotPools.getValue("pool").busyIntegralMs).isEqualTo(12.0)
        assertThat(connection.slotPools.getValue("pool").totalWaitMs).isEqualTo(4.0)
        assertThat(connection.orphaned).isZero()
        assertThat(
            rig.result.services
                .getValue("backend")
                .admittedAttempts,
        ).isEqualTo(1)
    }

    @Test
    fun `pooler slowdown errors and availability use its local delay and preserve interval boundaries`() {
        for (kind in listOf(FaultKind.SLOWDOWN, FaultKind.ERRORS, FaultKind.UNAVAILABLE, FaultKind.BLACKHOLE)) {
            val base = graph()
            val downstream = base.calls.single().copy(pathSegments = listOf("query"), from = "backend", to = "database")
            val rig =
                simulate(
                    base.copy(
                        services =
                            base.services.map { if (it.path == "backend") it.copy(pooler = PoolerSettings(10, 100.0)) else it } +
                                base.services.last().copy(pathSegments = listOf("database"), processing = TestChains.fixed(0.0)),
                        calls = base.calls.map { it.copy(timeoutMs = 5.0) } + downstream,
                        faults =
                            listOf(
                                FaultSpan(
                                    "backend",
                                    10.0,
                                    20.0,
                                    kind,
                                    delayMs = if (kind == FaultKind.SLOWDOWN) 1.0 else 0.0,
                                    failureProbability = if (kind == FaultKind.ERRORS) 1.0 else null,
                                ),
                            ),
                    ),
                    listOf(9.0, 10.0, 20.0),
                )
            val middle =
                when (kind) {
                    FaultKind.SLOWDOWN -> 13.0
                    FaultKind.ERRORS -> 12.0
                    FaultKind.UNAVAILABLE -> 10.0
                    else -> 15.0
                }
            assertThat(rig.completions).describedAs(kind.name).containsExactly(11.0, middle, 22.0)
            assertThat(rig.outcomes.last()).isEqualTo(AttemptOutcome.SUCCEEDED)
            assertThat(
                rig.result.services
                    .getValue("database")
                    .admittedAttempts,
            ).isEqualTo(if (kind == FaultKind.SLOWDOWN) 3 else 2)
        }
    }

    @Test
    fun `least in flight keeps a blackholed route occupied until its attempt times out`() {
        val base = graph(routed = true)
        val rig =
            simulate(
                base.copy(
                    services = base.services + base.services.last().copy(pathSegments = listOf("alternative")),
                    calls = base.calls.map { it.copy(timeoutMs = 5.0) },
                    routers = base.routers.map { it.copy(policy = RoutingPolicy.LEAST_IN_FLIGHT) },
                    routes = base.routes + RouteEdge("second-route", "router", "alternative"),
                    faults = listOf(FaultSpan("route", 0.0, 20.0, FaultKind.BLACKHOLE)),
                ),
                listOf(0.0, 1.0, 10.0),
            )
        assertThat(rig.completions).containsExactly(5.0, 3.0, 15.0)
        assertThat(rig.outcomes).containsExactly(AttemptOutcome.TIMED_OUT, AttemptOutcome.SUCCEEDED, AttemptOutcome.TIMED_OUT)
        assertThat(
            rig.result.connections
                .getValue("route")
                .timeouts,
        ).isEqualTo(2)
        assertThat(
            rig.result.connections
                .getValue("second-route")
                .succeeded,
        ).isEqualTo(1)
    }

    @Test
    fun `adjacent zero capacity intervals never admit work at their shared boundary`() {
        for (target in listOf("backend", "entry-to-backend")) {
            val base = graph()
            val rig =
                simulate(
                    base.copy(
                        services = base.services.map { if (it.path == "backend") it.copy(handlers = 1) else it },
                        calls = base.calls.map { if (target == it.path) it.copy(pool = CallPool(1, 100.0)) else it },
                        faults =
                            listOf(
                                FaultSpan(target, 0.0, 10.0, FaultKind.CAPACITY_LOSS, capacity = 0),
                                FaultSpan(target, 10.0, 20.0, FaultKind.CAPACITY_LOSS, capacity = 0),
                            ),
                    ),
                    listOf(1.0),
                )
            assertThat(rig.completions).describedAs(target).containsExactly(22.0)
        }
    }

    @Test
    fun `fault starts before queued processing resumes at the same instant`() {
        val base = graph()
        val rig =
            simulate(
                base.copy(
                    services =
                        base.services.map {
                            if (it.path ==
                                "backend"
                            ) {
                                it.copy(handlers = 1, processing = TestChains.fixed(5.0))
                            } else {
                                it
                            }
                        },
                    faults = listOf(FaultSpan("backend", 5.0, 10.0, FaultKind.SLOWDOWN, multiplier = 2.0)),
                ),
                listOf(0.0, 1.0),
            )
        assertThat(rig.completions).containsExactly(5.0, 15.0)
    }

    private fun graph(routed: Boolean = false): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                base.services.map {
                    it.copy(
                        handlers = 10,
                        queueCapacity = 100,
                        processing =
                            TestChains.fixed(
                                if (it.path ==
                                    "entry"
                                ) {
                                    0.0
                                } else {
                                    2.0
                                },
                            ),
                    )
                },
            calls = base.calls.map { it.copy(to = if (routed) "router" else "backend", timeoutMs = 100.0, attempts = 1) },
            routers = if (routed) listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)) else emptyList(),
            routes = if (routed) listOf(RouteEdge("route", "router", "backend")) else emptyList(),
        )
    }

    private data class Rig(
        val invocations: List<ReliabilityModel.ServiceInvocation>,
        val result: ReplicationResult,
    ) {
        val completions get() = invocations.map { it.work.processCompletionTime }
        val outcomes get() = invocations.map { it.outcome }
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double>,
    ): Rig {
        val simulation = Model("fault-simulation", autoCSVReports = false)
        val reliability = TestChains.reliabilityModel(simulation, graph)
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(simulation, name = "fault-driver") {
            override fun initialize() {
                arrivals.forEach { arrival ->
                    schedule<Nothing>(
                        eventAction = { invocations += reliability.invoke(graph.entry, originalRequest = true) },
                        timeToEvent = arrival,
                    )
                }
            }
        }
        simulation.numberOfReplications = 1
        simulation.lengthOfReplication = 1_100.0
        simulation.simulate()
        reliability.metrics.verifyConnectionsDrained()
        assertThat(reliability.activeInvocations).isZero()
        assertThat(reliability.activeDownstreamProcesses).isZero()
        assertThat(reliability.activeOriginalRequests).isZero()
        return Rig(invocations, reliability.metrics.replicationResult())
    }
}
