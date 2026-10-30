package resiliencelab.core.results

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.compiler.PoolerTestModel
import resiliencelab.core.engine.ksl.PathStreamSource
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.ReliabilityModel
import resiliencelab.core.engine.ksl.StreamPlan
import kotlin.test.Test

class SlotPoolSimulationTest {
    @Test
    fun `deterministic arrivals isolate all four limited resources at the expected window`() {
        val base =
            requireNotNull(PoolerTestModel.compile(PoolerTestModel.withServicePool()).experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        val cases =
            listOf(
                Triple("pool", "to-pooler", "RESULT_SLOT_POOL"),
                Triple("serverConnections", "pooler", "RESULT_SLOT_SERVERS"),
                Triple("clientConnections", "pooler", "RESULT_SLOT_CLIENTS"),
                Triple("handlers", "db", "RESULT_SLOT_DATABASE"),
            )
        for ((slot, element, code) in cases) {
            val graph =
                base.copy(
                    run = base.run.copy(measurementMs = 300.0, windowMs = 50.0),
                    services =
                        base.services.map { node ->
                            node.copy(
                                handlers =
                                    if ((slot == "clientConnections" && node.path == "pooler") ||
                                        (slot == "handlers" && node.path == "db")
                                    ) {
                                        1
                                    } else {
                                        100
                                    },
                                queueCapacity = if (node.pooler == null) 100 else 0,
                                processing = node.processing.copy(meanMs = if (node.path == "db") 200.0 else 0.0),
                                pooler =
                                    node.pooler?.copy(
                                        poolSize =
                                            if (slot ==
                                                "serverConnections"
                                            ) {
                                                1
                                            } else {
                                                100
                                            },
                                        waitTimeoutMs = 10_000.0,
                                    ),
                            )
                        },
                    calls =
                        base.calls.map { call ->
                            call.copy(
                                timeoutMs = 10_000.0,
                                pool = if (slot == "pool") call.pool?.copy(size = 1, acquireTimeoutMs = 10_000.0) else null,
                            )
                        },
                )
            val model = Model("SlotPoolSimulationTest-$slot", autoCSVReports = false)
            val windows = mutableListOf<NodeWindow>()
            val streams = PathStreamSource(StreamPlan(PathStreams.keys(graph, 0)), graph.run.seed, 0)
            val reliability =
                ReliabilityModel(model, graph, streams, onWindow = { _, nodes, connections ->
                    windows += nodes
                    windows +=
                        connections.map {
                            NodeWindow(
                                it.id,
                                WindowMetrics(it.metrics.startMs, it.metrics.durationMs, slotPools = it.metrics.slotPools),
                            )
                        }
                })
            object : ProcessModel(model, name = "driver") {
                override fun initialize() {
                    (0 until 30).forEach { request ->
                        reliability.invoke(graph.entry, request * 10.0, originalRequest = true, measurementCohort = true)
                    }
                }
            }
            model.numberOfReplications = 1
            model.lengthOfReplication = 10_000.0
            model.simulate()
            val result =
                SaturationAnalyzer.detect(
                    0,
                    windows.asSequence(),
                    positions = SlotPoolLabels.positions(graph),
                    labels = SlotPoolLabels.from(graph),
                )
            assertThat(result.degradationPath.map { Triple(it.node, it.slotPool, it.startMs) })
                .describedAs(slot)
                .containsExactly(Triple(element, slot, 0.0))
            assertThat(
                result.degradationPath
                    .single()
                    .label.code,
            ).describedAs(slot).isEqualTo(code)
        }
    }
}
