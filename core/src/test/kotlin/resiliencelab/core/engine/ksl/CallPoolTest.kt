package resiliencelab.core.engine.ksl

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.CallPool
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.results.ConnectionWindow
import kotlin.test.Test

class CallPoolTest {
    private val json = Json { encodeDefaults = true }

    @Test
    fun `wait for connection precedes attempt timeout`() {
        val rig = simulate(graph(timeout = 25.0), listOf(0.0, 1.0))
        assertThat(rig.completionTimes).containsExactly(20.0, 40.0)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .succeeded,
        ).isEqualTo(2)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .timeouts,
        ).isZero()
    }

    @Test
    fun `connection stays occupied through request and response network delay`() {
        val rig = simulate(graph(network = 5.0), listOf(0.0, 1.0))
        assertThat(rig.completionTimes).containsExactly(30.0, 60.0)
    }

    @Test
    fun `acquisition expiry consumes an attempt and retries after backoff`() {
        val rig = simulate(graph(acquireTimeout = 5.0, attempts = 2, backoff = 10.0), listOf(0.0, 1.0))
        assertThat(rig.completionTimes).containsExactly(20.0, 40.0)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .sentAttempts,
        ).isEqualTo(2)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .retries,
        ).isEqualTo(1)
        assertThat(
            rig.result.services
                .getValue("entry")
                .retries,
        ).isEqualTo(1)
    }

    @Test
    fun `timeout releases connection while orphaned work continues`() {
        val rig = simulate(graph(processing = 50.0, timeout = 10.0), listOf(0.0, 1.0))
        assertThat(rig.completionTimes).containsExactly(10.0, 20.0)
        val call = rig.result.connections.getValue(CALL)
        assertThat(call.timeouts).isEqualTo(2)
        assertThat(call.orphaned).isEqualTo(2)
        assertThat(call.orphanedIntegralMs).isEqualTo(80.0)
    }

    @Test
    fun `deadline removes pool waiter without sending or retrying`() {
        val base = graph(processing = 50.0, acquireTimeout = 100.0, attempts = 3)
        val rig = simulate(base.copy(clients = listOf(base.client.copy(deadlineMs = 10.0))), listOf(0.0, 1.0), unboundedFirst = true)
        assertThat(rig.completionTimes).containsExactly(50.0, 11.0)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .sentAttempts,
        ).isEqualTo(1)
        assertThat(
            rig.result.services
                .getValue("entry")
                .retries,
        ).isZero()
        assertThat(rig.invocations[1].outcome).isEqualTo(AttemptOutcome.DEADLINE_EXCEEDED)
    }

    @Test
    fun `slot release wins when acquisition expires at the same instant`() {
        val rig = simulate(graph(acquireTimeout = 19.0), listOf(0.0, 1.0))
        assertThat(rig.completionTimes).containsExactly(20.0, 40.0)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .succeeded,
        ).isEqualTo(2)
    }

    @Test
    fun `zero acquisition timeout admits a free slot and rejects a busy pool immediately`() {
        val rig = simulate(graph(acquireTimeout = 0.0), listOf(0.0, 1.0))
        assertThat(rig.completionTimes).containsExactly(20.0, 1.0)
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .sentAttempts,
        ).isEqualTo(1)
        assertThat(rig.result.successes).isEqualTo(1)
    }

    @Test
    fun `replica callers own independent pools even when the target is shared`() {
        val base = graph()
        val services =
            listOf(
                base.services[0].copy(pathSegments = listOf("caller", "#1")),
                base.services[0].copy(pathSegments = listOf("caller", "#2")),
                base.services[1],
            )
        val graph =
            base.copy(
                clients = listOf(base.client.copy(entry = "lb")),
                services = services,
                calls =
                    services.take(2).mapIndexed {
                        i,
                        service,
                        ->
                        base.calls.single().copy(pathSegments = listOf("call", "#${i + 1}"), from = service.path)
                    },
                routers = listOf(RouterNode("lb", RoutingPolicy.ROUND_ROBIN)),
                routes = services.take(2).mapIndexed { i, service -> RouteEdge("route-$i", "lb", service.path) },
            )
        val rig = simulate(graph, listOf(0.0, 0.0))
        assertThat(rig.completionTimes).containsExactly(20.0, 20.0)
        assertThat(
            rig.result.connections
                .getValue("call#1")
                .succeeded,
        ).isEqualTo(1)
        assertThat(
            rig.result.connections
                .getValue("call#2")
                .succeeded,
        ).isEqualTo(1)
    }

    @Test
    fun `pool statistics separate occupied capacity queue time waits and acquisition timeouts`() {
        val rig = simulate(graph(acquireTimeout = 5.0, attempts = 2, backoff = 10.0), listOf(0.0, 1.0))
        val metrics =
            json
                .encodeToJsonElement(
                    resiliencelab.core.experiment.ConnectionMetrics
                        .serializer(),
                    rig.result.connections.getValue(CALL),
                ).jsonObject
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["busyIntegralMs"],
        ).isEqualTo(JsonPrimitive(40.0))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["capacityIntegralMs"],
        ).isEqualTo(JsonPrimitive(100.0))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["queueIntegralMs"],
        ).isEqualTo(JsonPrimitive(9.0))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["waitCount"],
        ).isEqualTo(JsonPrimitive(2))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["totalWaitMs"],
        ).isEqualTo(JsonPrimitive(9.0))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["waitLimitCount"],
        ).isEqualTo(JsonPrimitive(1))
        val windows =
            rig.windows.map {
                json
                    .encodeToJsonElement(
                        resiliencelab.core.results.ConnectionWindowMetrics
                            .serializer(),
                        it.metrics,
                    ).jsonObject
            }
        assertThat(
            windows.map {
                it
                    .getValue("slotPools")
                    .jsonObject
                    .getValue("pool")
                    .jsonObject["busyIntegralMs"]
            },
        ).containsExactlyElementsOf(
            listOf(10.0, 10.0, 10.0, 10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0).map(::JsonPrimitive),
        )
        assertThat(
            windows.map {
                it
                    .getValue("slotPools")
                    .jsonObject
                    .getValue("pool")
                    .jsonObject["waitCount"]
            },
        ).containsExactlyElementsOf(
            listOf(1, 0, 1, 0, 0, 0, 0, 0, 0, 0).map(::JsonPrimitive),
        )
    }

    @Test
    fun `pool integrals include warmup occupancy but cohort waits include runout`() {
        val base = graph(processing = 50.0)
        val rig = simulate(base.copy(run = base.run.copy(warmupMs = 10.0, measurementMs = 20.0)), listOf(0.0, 15.0))
        val metrics =
            json
                .encodeToJsonElement(
                    resiliencelab.core.experiment.ConnectionMetrics
                        .serializer(),
                    rig.result.connections.getValue(CALL),
                ).jsonObject
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["busyIntegralMs"],
        ).isEqualTo(JsonPrimitive(20.0))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["capacityIntegralMs"],
        ).isEqualTo(JsonPrimitive(20.0))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["queueIntegralMs"],
        ).isEqualTo(JsonPrimitive(15.0))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["waitCount"],
        ).isEqualTo(JsonPrimitive(1))
        assertThat(
            metrics
                .getValue("slotPools")
                .jsonObject
                .getValue("pool")
                .jsonObject["totalWaitMs"],
        ).isEqualTo(JsonPrimitive(35.0))
        val windows =
            rig.windows.map {
                json
                    .encodeToJsonElement(
                        resiliencelab.core.results.ConnectionWindowMetrics
                            .serializer(),
                        it.metrics,
                    ).jsonObject
            }
        assertThat(
            windows.map {
                it
                    .getValue("slotPools")
                    .jsonObject
                    .getValue("pool")
                    .jsonObject["waitCount"]
            },
        ).containsOnly(JsonPrimitive(0))
    }

    private fun graph(
        processing: Double = 20.0,
        network: Double = 0.0,
        timeout: Double = 100.0,
        acquireTimeout: Double = 100.0,
        attempts: Int = 1,
        backoff: Double = 0.0,
    ): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                listOf(
                    base.services[0].copy(handlers = 4, processing = TestChains.fixed(0.0)),
                    base.services[1].copy(handlers = 4, processing = TestChains.fixed(processing)),
                ),
            calls =
                listOf(
                    base.calls.single().copy(
                        network = TestChains.fixed(network),
                        timeoutMs = timeout,
                        attempts = attempts,
                        backoff = TestChains.fixedBackoff(backoff),
                        pool = CallPool(1, acquireTimeout),
                    ),
                ),
            run = base.run.copy(measurementMs = 100.0, windowMs = 10.0),
        )
    }

    private fun simulate(
        graph: GraphIr,
        arrivals: List<Double>,
        unboundedFirst: Boolean = false,
    ): Rig {
        val simulation = Model("CallPoolTest", autoCSVReports = false)
        val windows = mutableListOf<ConnectionWindow>()
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
        val reliability = ReliabilityModel(simulation, graph, streams, onWindow = { _, _, rows -> windows += rows })
        val invocations = mutableListOf<ReliabilityModel.ServiceInvocation>()
        object : ProcessModel(simulation, name = "pool-driver") {
            override fun initialize() {
                arrivals.forEachIndexed { i, arrival ->
                    invocations +=
                        reliability.invoke(
                            graph.entry,
                            arrival,
                            originalRequest = !unboundedFirst || i != 0,
                            measurementCohort = arrival >= graph.run.warmupMs,
                        )
                }
            }
        }
        simulation.numberOfReplications = 1
        simulation.lengthOfReplication = 1_000.0
        simulation.simulate()
        assertThat(reliability.activeInvocations).isZero()
        assertThat(reliability.activeDownstreamProcesses).isZero()
        reliability.metrics.verifyConnectionsDrained()
        return Rig(reliability.metrics.replicationResult(), invocations, windows)
    }

    private data class Rig(
        val result: ReplicationResult,
        val invocations: List<ReliabilityModel.ServiceInvocation>,
        val windows: List<ConnectionWindow>,
    ) {
        val completionTimes: List<Double> get() = invocations.map { it.work.processCompletionTime }
    }

    companion object {
        private const val CALL = "entry-to-backend"
    }
}
