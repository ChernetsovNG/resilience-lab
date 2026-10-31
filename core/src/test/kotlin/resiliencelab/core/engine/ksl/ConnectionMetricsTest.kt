package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.results.ConnectionWindow
import kotlin.test.Test

class ConnectionMetricsTest {
    @Test
    fun `timeout tracks orphan until the response network finishes across window boundaries`() {
        val rig = simulate(chain(processingMs = 27.0, networkMs = 10.0, timeoutMs = 25.0))
        val connection = rig.result.connections.getValue(CALL)
        assertThat(connection.sentAttempts).isEqualTo(1)
        assertThat(connection.timeouts).isEqualTo(1)
        assertThat(connection.orphaned).isEqualTo(1)
        assertThat(connection.succeeded + connection.failed).isZero()
        assertThat(connection.latency.count).isZero()
        assertThat(connection.inFlightIntegralMs).isEqualTo(25.0)
        assertThat(connection.orphanedIntegralMs).isEqualTo(22.0)
        assertThat(rig.windows.map { it.metrics.orphanedIntegralMs })
            .containsExactly(0.0, 0.0, 5.0, 10.0, 7.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        assertThat(rig.windows.map { it.metrics.inFlightIntegralMs })
            .containsExactly(10.0, 10.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        assertInvariants(rig)
    }

    @Test
    fun `each failed response has latency and retries include their backoff occupancy`() {
        val base = chain(processingMs = 5.0, attempts = 3, backoffMs = 7.0)
        val rig = simulate(base.copy(services = base.services.map { if (it.path == "backend") it.copy(failureProbability = 1.0) else it }))
        val connection = rig.result.connections.getValue(CALL)
        assertThat(connection.sentAttempts).isEqualTo(3)
        assertThat(connection.retries).isEqualTo(2)
        assertThat(connection.failed).isEqualTo(3)
        assertThat(connection.timeouts).isZero()
        assertThat(connection.latency.count).isEqualTo(3L)
        assertThat(connection.latency.sumMs).isEqualTo(15.0)
        assertThat(connection.inFlightIntegralMs).isEqualTo(15.0)
        assertThat(connection.backoffIntegralMs).isEqualTo(14.0)
        assertThat(rig.windows.take(3).map { it.metrics.retries }).containsExactly(0, 1, 1)
        assertInvariants(rig)
    }

    @Test
    fun `queue rejection counts as a failed response with zero latency`() {
        val base = chain(processingMs = 10.0)
        val rig =
            simulate(
                base.copy(services = listOf(base.services[0].copy(handlers = 2), base.services[1].copy(queueCapacity = 0))),
                arrivals = listOf(0.0, 0.0),
            )
        val connection = rig.result.connections.getValue(CALL)
        assertThat(connection.sentAttempts).isEqualTo(2)
        assertThat(connection.succeeded).isEqualTo(1)
        assertThat(connection.failed).isEqualTo(1)
        assertThat(connection.latency.count).isEqualTo(2L)
        assertThat(connection.latency.sumMs).isEqualTo(10.0)
        assertThat(connection.latency.sketch.first()).isEqualTo(1L)
        assertInvariants(rig)
    }

    @Test
    fun `deadline shortened timeout remains a timeout and never starts another attempt`() {
        val base = chain(processingMs = 80.0, timeoutMs = 200.0, attempts = 3)
        val rig = simulate(base.copy(clients = listOf(base.client.copy(deadlineMs = 30.0))))
        val connection = rig.result.connections.getValue(CALL)
        assertThat(connection.timeouts).isEqualTo(1)
        assertThat(connection.orphaned).isEqualTo(1)
        assertThat(connection.retries).isZero()
        assertThat(connection.latency.count).isZero()
        assertThat(connection.inFlightIntegralMs).isEqualTo(30.0)
        assertThat(connection.orphanedIntegralMs).isEqualTo(50.0)
        assertInvariants(rig)
    }

    @Test
    fun `response at the timeout instant wins without orphaning`() {
        val rig = simulate(chain(processingMs = 40.0, timeoutMs = 40.0))
        val connection = rig.result.connections.getValue(CALL)
        assertThat(connection.succeeded).isEqualTo(1)
        assertThat(connection.timeouts).isZero()
        assertThat(connection.orphaned).isZero()
        assertThat(connection.latency.sumMs).isEqualTo(40.0)
        assertInvariants(rig)
    }

    @Test
    fun `runout closes cohort attempts but does not extend window or measurement integrals`() {
        for (timeout in listOf(10.0, 50.0)) {
            val rig = simulate(chain(processingMs = 20.0, timeoutMs = timeout), arrivals = listOf(95.0))
            val connection = rig.result.connections.getValue(CALL)
            assertThat(connection.sentAttempts).isEqualTo(1)
            assertThat(connection.inFlightIntegralMs).isEqualTo(5.0)
            assertThat(connection.orphanedIntegralMs).isZero()
            assertThat(rig.windows.sumOf { it.metrics.timeouts + it.metrics.succeeded + it.metrics.failed }).isZero()
            if (timeout == 10.0) {
                assertThat(connection.timeouts).isEqualTo(1)
                assertThat(connection.orphaned).isEqualTo(1)
                assertThat(connection.latency.count).isZero()
            } else {
                assertThat(connection.succeeded).isEqualTo(1)
                assertThat(connection.latency.sumMs).isEqualTo(20.0)
            }
            assertInvariants(rig)
        }
    }

    @Test
    fun `measurement integrals include warmup work while counters follow the measured arrival cohort`() {
        val base = chain(processingMs = 25.0, timeoutMs = 20.0)
        val rig =
            simulate(
                base.copy(
                    services = base.services.map { it.copy(handlers = 2) },
                    run = base.run.copy(warmupMs = 10.0, measurementMs = 20.0),
                ),
                arrivals = listOf(0.0, 15.0),
            )
        val connection = rig.result.connections.getValue(CALL)
        assertThat(connection.sentAttempts).isEqualTo(1)
        assertThat(connection.timeouts).isEqualTo(1)
        assertThat(connection.orphaned).isEqualTo(1)
        assertThat(connection.measurementMs).isEqualTo(20.0)
        assertThat(connection.inFlightIntegralMs).isEqualTo(25.0)
        assertThat(connection.orphanedIntegralMs).isEqualTo(5.0)
        assertThat(rig.windows.sumOf { it.metrics.sentAttempts }).isEqualTo(2)
        assertInvariants(rig)
    }

    @Test
    fun `events at a boundary enter the next window and the end remains excluded`() {
        val base = chain(processingMs = 15.0)
        val rig = simulate(base.copy(run = base.run.copy(measurementMs = 25.0)), arrivals = listOf(10.0))
        assertThat(rig.windows.map { it.metrics.durationMs }).containsExactly(10.0, 10.0, 5.0)
        assertThat(rig.windows.map { it.metrics.sentAttempts }).containsExactly(0, 1, 0)
        assertThat(rig.windows.sumOf { it.metrics.succeeded }).isZero()
        assertThat(
            rig.result.connections
                .getValue(CALL)
                .succeeded,
        ).isEqualTo(1)
        assertThat(rig.windows.map { it.metrics.inFlightIntegralMs }).containsExactly(0.0, 10.0, 5.0)
        assertInvariants(rig)
    }

    private fun assertInvariants(rig: Rig) {
        val connection = rig.result.connections.getValue(CALL)
        assertThat(connection.succeeded + connection.failed + connection.timeouts).isEqualTo(connection.sentAttempts)
        assertThat(connection.sentAttempts).isEqualTo(
            rig.result.services
                .getValue("backend")
                .offeredAttempts,
        )
        assertThat(connection.timeouts).isEqualTo(
            rig.result.services
                .getValue("entry")
                .timeouts,
        )
        assertThat(connection.retries).isEqualTo(
            rig.result.services
                .getValue("entry")
                .retries,
        )
        assertThat(connection.orphaned).isLessThanOrEqualTo(connection.timeouts)
        assertThat(rig.model.activeInvocations).isZero()
        assertThat(rig.model.activeDownstreamProcesses).isZero()
        rig.model.metrics.verifyConnectionsDrained()
    }

    private fun chain(
        processingMs: Double,
        networkMs: Double = 0.0,
        timeoutMs: Double = 100.0,
        attempts: Int = 1,
        backoffMs: Double = 0.0,
    ): GraphIr {
        val base = TestChains.simple()
        return base.copy(
            services =
                listOf(
                    base.services[0].copy(processing = TestChains.fixed(0.0)),
                    base.services[1].copy(processing = TestChains.fixed(processingMs)),
                ),
            calls =
                listOf(
                    base.calls.single().copy(
                        network = TestChains.fixed(networkMs),
                        timeoutMs = timeoutMs,
                        attempts = attempts,
                        backoff = TestChains.fixedBackoff(backoffMs),
                    ),
                ),
            run = base.run.copy(measurementMs = 100.0, windowMs = 10.0),
        )
    }

    private fun simulate(
        chain: GraphIr,
        arrivals: List<Double> = listOf(0.0),
    ): Rig {
        val model = Model("ConnectionMetricsTest", autoCSVReports = false)
        val windows = mutableListOf<ConnectionWindow>()
        val streams = PathStreamSource(StreamPlan(PathStreams.keys(chain, 0)), chain.run.seed, 0)
        val reliability = ReliabilityModel(model, chain, streams, onWindow = { _, _, rows -> windows += rows })
        object : ProcessModel(model, name = "connection-invocation-driver") {
            override fun initialize() {
                arrivals.forEach { arrival ->
                    reliability.invoke(
                        serviceId = chain.entry,
                        timeUntilActivation = arrival,
                        originalRequest = true,
                        measurementCohort = arrival >= chain.run.warmupMs,
                    )
                }
            }
        }
        model.numberOfReplications = 1
        model.lengthOfReplication = 1_000.0
        model.simulate()
        return Rig(reliability.metrics.replicationResult(), windows, reliability)
    }

    private data class Rig(
        val result: ReplicationResult,
        val windows: List<ConnectionWindow>,
        val model: ReliabilityModel,
    )

    companion object {
        private const val CALL = "entry-to-backend"
    }
}
