package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.FallbackConfig
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.RepeatConfig
import resiliencelab.core.ir.RepeatMode
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class ParallelScenarioTest {
    @Test
    fun `sequential repeat multiplies processing time`() {
        val rig = simulate(graph(listOf(ServiceStep.Process(TestChains.fixed(3.0), repeat = RepeatConfig(4, RepeatMode.SEQUENTIAL)))))
        assertThat(rig.completionTimes).containsExactly(12.0)
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
    }

    @Test
    fun `sequential repeat stops at the first failed copy`() {
        val rig =
            simulate(graph(listOf(ServiceStep.Process(failureProbability = 1.0, repeat = RepeatConfig(4, RepeatMode.SEQUENTIAL)))))
        assertThat(rig.completionTimes).containsExactly(2.0)
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.LOCAL_FAILURE)
        assertThat(
            rig.result.services
                .getValue("entry")
                .failures,
        ).isEqualTo(1)
    }

    @Test
    fun `parallel processing copies execute concurrently`() {
        val rig = simulate(graph(listOf(ServiceStep.Process(TestChains.fixed(3.0), repeat = RepeatConfig(4, RepeatMode.PARALLEL)))))
        assertThat(rig.completionTimes).containsExactly(3.0)
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.SUCCEEDED)
    }

    @Test
    fun `parallel call copies wait for the slowest queued copy without becoming retries`() {
        val base = graph(listOf(ServiceStep.Call("a", repeat = RepeatConfig(3, RepeatMode.PARALLEL))))
        val rig =
            simulate(
                base.copy(
                    services = base.services.map { if (it.path == "left") it.copy(handlers = 1) else it },
                    calls = base.calls.map { it.copy(network = TestChains.fixed(1.0)) },
                ),
            )
        // Requests arrive together at 1 ms; responses complete at 7, 12 and 17 ms.
        assertThat(rig.completionTimes).containsExactly(17.0)
        val connection = rig.result.connections.getValue("a")
        assertThat(connection.sentAttempts).isEqualTo(3)
        assertThat(connection.succeeded).isEqualTo(3)
        assertThat(connection.retries).isZero()
        assertThat(connection.latency.sumMs).isEqualTo(36.0)
    }

    @Test
    fun `parallel branches retain one handler until the slowest branch finishes`() {
        val rig =
            simulate(
                graph(
                    listOf(
                        ServiceStep.Parallel(
                            listOf(
                                listOf(ServiceStep.Process(), ServiceStep.Call("a")),
                                listOf(ServiceStep.Call("b"), ServiceStep.Process(TestChains.fixed(1.0))),
                            ),
                        ),
                    ),
                ),
                arrivals = listOf(0.0, 1.0),
            )
        assertThat(rig.completionTimes).containsExactly(12.0, 24.0)
        val handlers =
            rig.result.services
                .getValue("entry")
                .slotPools
                .getValue("handlers")
        assertThat(handlers.busyIntegralMs).isEqualTo(24.0)
        assertThat(handlers.queueIntegralMs).isEqualTo(11.0)
    }

    @Test
    fun `first failing branch determines the reason while other branches complete`() {
        val base =
            graph(
                listOf(
                    ServiceStep.Parallel(
                        listOf(listOf(ServiceStep.Call("b")), listOf(ServiceStep.Call("a")), listOf(ServiceStep.Call("c"))),
                    ),
                    ServiceStep.Call("b"),
                ),
            )
        val rig =
            simulate(
                base.copy(
                    services =
                        base.services.map { if (it.path == "right") it.copy(failureProbability = 1.0) else it } +
                            ServiceNode("late", 1, 10, TestChains.fixed(25.0), 0.0),
                    calls =
                        base.calls.map { if (it.path == "a") it.copy(timeoutMs = 2.0) else it } +
                            CallEdge("c", "entry", "late", TestChains.fixed(0.0), 100.0, 1, TestChains.noBackoff),
                ),
            )
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.LOCAL_FAILURE)
        assertThat(rig.completionTimes).containsExactly(25.0)
        assertThat(
            rig.result.connections
                .getValue("a")
                .timeouts,
        ).isEqualTo(1)
        assertThat(
            rig.result.connections
                .getValue("b")
                .sentAttempts,
        ).isEqualTo(1)
        assertThat(
            rig.result.connections
                .getValue("c")
                .succeeded,
        ).isEqualTo(1)
    }

    @Test
    fun `first failing parallel copy determines the reason in copy order`() {
        val base = graph(listOf(ServiceStep.Call("a", repeat = RepeatConfig(3, RepeatMode.PARALLEL))))
        val targets = listOf("left", "right", "late").iterator()
        val rig =
            simulate(
                base.copy(
                    services =
                        base.services.map { if (it.path == "left") it.copy(failureProbability = 1.0) else it } +
                            ServiceNode("late", 1, 10, TestChains.fixed(25.0), 0.0),
                    faults = listOf(FaultSpan("right", 0.0, 50.0, FaultKind.UNAVAILABLE)),
                ),
                selectTarget = { _, _ -> targets.next() },
            )
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.LOCAL_FAILURE)
        assertThat(rig.completionTimes).containsExactly(25.0)
        assertThat(
            rig.result.connections
                .getValue("a")
                .sentAttempts,
        ).isEqualTo(3)
        assertThat(
            rig.result.connections
                .getValue("a")
                .succeeded,
        ).isEqualTo(1)
    }

    @Test
    fun `nested parallel steps and sequential repeats compose`() {
        val rig =
            simulate(
                graph(
                    listOf(
                        ServiceStep.Parallel(
                            listOf(
                                listOf(ServiceStep.Process(TestChains.fixed(3.0), repeat = RepeatConfig(2, RepeatMode.SEQUENTIAL))),
                                listOf(ServiceStep.Parallel(listOf(listOf(ServiceStep.Call("a")), listOf(ServiceStep.Call("b"))))),
                            ),
                            repeat = RepeatConfig(2, RepeatMode.SEQUENTIAL),
                        ),
                    ),
                ),
            )
        assertThat(rig.completionTimes).containsExactly(22.0)
        assertThat(
            rig.result.connections
                .getValue("a")
                .succeeded,
        ).isEqualTo(2)
        assertThat(
            rig.result.connections
                .getValue("b")
                .succeeded,
        ).isEqualTo(2)
    }

    @Test
    fun `request class filters skip entire branches and individual nested steps`() {
        val base =
            graph(
                listOf(
                    ServiceStep.Parallel(listOf(listOf(ServiceStep.Call("a"))), classes = setOf("other")),
                    ServiceStep.Parallel(
                        listOf(
                            listOf(ServiceStep.Call("b", classes = setOf("other"))),
                            listOf(ServiceStep.Process(TestChains.fixed(3.0), classes = setOf("status"))),
                        ),
                    ),
                ),
            )
        val rig =
            simulate(
                base.copy(clients = listOf(base.client.copy(classes = mapOf("status" to LoadProfile.constant(0.01))))),
                requestClass = "status",
            )
        assertThat(rig.completionTimes).containsExactly(3.0)
        assertThat(
            rig.result.connections.values
                .sumOf { it.sentAttempts },
        ).isZero()
        assertThat(
            rig.result.entries.classes
                .getValue("status")
                .successes,
        ).isEqualTo(1)
    }

    @Test
    fun `branches share the original deadline and drain timed out children`() {
        val base = graph(listOf(ServiceStep.Parallel(listOf(listOf(ServiceStep.Call("a")), listOf(ServiceStep.Call("b"))))))
        val rig = simulate(base.copy(clients = listOf(base.client.copy(deadlineMs = 7.0))))
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.DEADLINE_EXCEEDED)
        assertThat(rig.completionTimes).containsExactly(7.0)
        assertThat(
            rig.result.connections
                .getValue("a")
                .succeeded,
        ).isEqualTo(1)
        assertThat(
            rig.result.connections
                .getValue("b")
                .orphanedIntegralMs,
        ).isEqualTo(4.0)
        assertThat(
            rig.result.services
                .getValue("right")
                .slotPools
                .getValue("handlers")
                .busyIntegralMs,
        ).isEqualTo(11.0)
    }

    @Test
    fun `fallback in a nested branch marks the original request degraded`() {
        val base =
            graph(
                listOf(
                    ServiceStep.Parallel(
                        listOf(
                            listOf(ServiceStep.Call("a")),
                            listOf(ServiceStep.Parallel(listOf(listOf(ServiceStep.Call("b"))))),
                        ),
                    ),
                ),
            )
        val rig =
            simulate(
                base.copy(
                    services = base.services.map { if (it.path == "right") it.copy(failureProbability = 1.0) else it },
                    calls = base.calls.map { if (it.path == "b") it.copy(fallback = FallbackConfig(setOf("error"), 2.0)) else it },
                ),
            )
        assertThat(rig.completionTimes).containsExactly(13.0)
        assertThat(rig.result.entries.total.successes).isEqualTo(1)
        assertThat(rig.result.entries.total.degraded).isEqualTo(1)
        assertThat(
            rig.result.connections
                .getValue("b")
                .fallbacks,
        ).isEqualTo(1)
    }

    @Test
    fun `orphaned service finishes every branch and retains its handler`() {
        val base = graph(listOf(ServiceStep.Call("a")))
        val rig =
            simulate(
                base.copy(
                    services =
                        base.services.map {
                            if (it.path == "left") {
                                it.copy(
                                    scenario =
                                        listOf(
                                            ServiceStep.Parallel(listOf(listOf(ServiceStep.Process()), listOf(ServiceStep.Call("b")))),
                                        ),
                                )
                            } else {
                                it
                            }
                        },
                    calls = base.calls.map { if (it.path == "a") it.copy(timeoutMs = 2.0) else it.copy(from = "left") },
                ),
            )
        assertThat(rig.invocations.single().outcome).isEqualTo(AttemptOutcome.TIMED_OUT)
        assertThat(rig.completionTimes).containsExactly(2.0)
        assertThat(
            rig.result.connections
                .getValue("a")
                .orphanedIntegralMs,
        ).isEqualTo(9.0)
        assertThat(
            rig.result.connections
                .getValue("b")
                .succeeded,
        ).isEqualTo(1)
        assertThat(
            rig.result.services
                .getValue("left")
                .slotPools
                .getValue("handlers")
                .busyIntegralMs,
        ).isEqualTo(11.0)
    }

    @Test
    fun `each parallel call acquires and releases its connection`() {
        val base = graph(listOf(ServiceStep.Call("a", repeat = RepeatConfig(3, RepeatMode.PARALLEL))))
        val rig = simulate(base.copy(calls = base.calls.map { it.copy(pool = CallPool(1, 100.0)) }))
        assertThat(rig.completionTimes).containsExactly(15.0)
        assertThat(
            rig.result.connections
                .getValue("a")
                .succeeded,
        ).isEqualTo(3)
        assertThat(
            rig.result.connections
                .getValue("a")
                .slotPools
                .getValue("pool")
                .busyIntegralMs,
        ).isEqualTo(15.0)
    }

    @Test
    fun `parallel calls have independent attempt numbering and backoff`() {
        val base = graph(listOf(ServiceStep.Call("a", repeat = RepeatConfig(3, RepeatMode.PARALLEL))))
        val rig =
            simulate(
                base.copy(
                    services = base.services.map { if (it.path == "left") it.copy(failureProbability = 1.0) else it },
                    calls = base.calls.map { it.copy(attempts = 2, backoff = TestChains.fixedBackoff(2.0)) },
                ),
            )
        assertThat(rig.completionTimes).containsExactly(12.0)
        assertThat(
            rig.result.connections
                .getValue("a")
                .sentAttempts,
        ).isEqualTo(6)
        assertThat(
            rig.result.connections
                .getValue("a")
                .retries,
        ).isEqualTo(3)
        assertThat(
            rig.result.connections
                .getValue("a")
                .backoffIntegralMs,
        ).isEqualTo(6.0)
    }

    @Test
    fun `branches keep the parent's measurement cohort`() {
        val rig =
            simulate(
                graph(listOf(ServiceStep.Call("a", repeat = RepeatConfig(3, RepeatMode.PARALLEL)))),
                measurementCohort = false,
            )
        assertThat(rig.completionTimes).containsExactly(5.0)
        assertThat(rig.result.entries.total.originalArrivals).isZero()
        assertThat(
            rig.result.connections
                .getValue("a")
                .sentAttempts,
        ).isZero()
        assertThat(
            rig.result.services
                .getValue("left")
                .admittedAttempts,
        ).isZero()
    }

    @Test
    fun `fan out increases entry p99 while mean call latency stays stable`() {
        val measurements =
            listOf(1, 20).map { count ->
                val base = graph(listOf(ServiceStep.Call("a", repeat = RepeatConfig(count, RepeatMode.PARALLEL))))
                val graph =
                    base.copy(
                        clients = listOf(base.client.copy(classes = mapOf("default" to LoadProfile.constant(0.05)))),
                        services =
                            base.services.map {
                                it.copy(handlers = 1024, processing = if (it.path == "left") TestChains.exponential(5.0) else it.processing)
                            },
                        run = base.run.copy(replications = 3, warmupMs = 1_000.0, measurementMs = 100_000.0, windowMs = 1_000.0),
                    )
                val results =
                    (0 until graph.run.replications).map { replication ->
                        TestChains
                            .reliabilityModel(Model("FanOut-$count-$replication", autoCSVReports = false), graph, replication)
                            .runReplication()
                    }
                val entry = LatencySketch()
                results.forEach { entry.merge(LatencySketch.fromBins(it.entries.total.allLatency.sketch)) }
                val calls = results.map { it.connections.getValue("a").latency }
                val p99Ms = requireNotNull(entry.percentile(0.99))
                val meanCallMs = calls.sumOf { it.sumMs } / calls.sumOf { it.count }
                println("Fan-out count=$count replications=3 requests=${entry.count} entryP99Ms=$p99Ms meanCallMs=$meanCallMs")
                p99Ms to meanCallMs
            }
        assertThat(measurements[1].first).isGreaterThan(measurements[0].first * 1.3)
        assertThat(measurements[1].second).isBetween(measurements[0].second * 0.95, measurements[0].second * 1.05)
    }

    private fun graph(steps: List<ServiceStep>): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                listOf(
                    ServiceNode("entry", 1, 10, TestChains.fixed(2.0), 0.0, scenario = steps),
                    ServiceNode("left", 20, 10, TestChains.fixed(5.0), 0.0),
                    ServiceNode("right", 20, 10, TestChains.fixed(11.0), 0.0),
                ),
            calls =
                listOf(
                    CallEdge("a", "entry", "left", TestChains.fixed(0.0), 100.0, 1, TestChains.noBackoff),
                    CallEdge("b", "entry", "right", TestChains.fixed(0.0), 100.0, 1, TestChains.noBackoff),
                ),
            run = base.run.copy(measurementMs = 100.0),
        )
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double> = listOf(0.0),
        requestClass: String = "default",
        measurementCohort: Boolean = true,
        selectTarget: (CallEdge, Int) -> String = { edge, _ -> edge.to },
    ): Rig {
        val model = Model("ParallelScenarioTest", autoCSVReports = false)
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(model, graph, streams, selectTarget = selectTarget)
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(model, name = "parallel-scenario-driver") {
            override fun initialize() {
                arrivals.forEach {
                    invocations +=
                        reliability.invoke(
                            graph.entry,
                            it,
                            originalRequest = true,
                            measurementCohort = measurementCohort,
                            requestClass = requestClass,
                        )
                }
            }
        }
        model.numberOfReplications = 1
        model.lengthOfReplication = 200.0
        model.simulate()
        assertThat(reliability.activeInvocations).isZero()
        assertThat(reliability.activeDownstreamProcesses).isZero()
        assertThat(reliability.activeOriginalRequests).isZero()
        reliability.metrics.verifyConnectionsDrained()
        return Rig(reliability, invocations)
    }

    private data class Rig(
        val reliability: ReliabilityModel,
        val invocations: List<ReliabilityModel.ServiceInvocation>,
    ) {
        val completionTimes get() = invocations.map { it.work.processCompletionTime }
        val result get() = reliability.metrics.replicationResult()
    }
}
