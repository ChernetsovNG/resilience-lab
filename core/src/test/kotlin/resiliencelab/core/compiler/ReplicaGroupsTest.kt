package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.GridAxis
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Variant
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.engine.ksl.StreamPlan
import resiliencelab.core.execution.CostEstimator
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class ReplicaGroupsTest {
    @Test
    fun `expands groups and copies outgoing scenarios with stable segmented paths`() {
        val graph = graph(model(3, tailReplicas = 2))
        assertThat(graph.services.map { it.path }).containsExactly(
            "gateway",
            "worker#1",
            "worker#2",
            "worker#3",
            "tail#1",
            "tail#2",
        )
        assertThat(graph.routers.map { it.path }).containsExactly("tail#lb", "worker#lb")
        assertThat(graph.routers.single { it.path == "worker#lb" }.policy).isEqualTo(RoutingPolicy.ROUND_ROBIN)
        assertThat(graph.calls.single { it.path == "gateway-to-worker" }.balancing).isEqualTo(RoutingPolicy.RANDOM)
        assertThat(graph.calls.single { it.path == "gateway-to-worker" }.to).isEqualTo("worker#lb")
        for (number in 1..3) {
            val instance = graph.services.single { it.path == "worker#$number" }
            assertThat(instance.pathSegments).containsExactly("worker", "#$number")
            assertThat(instance.origin.pointer).isEqualTo("/blocks/worker")
            assertThat(instance.scenario).containsExactly(
                ServiceStep.Process(),
                ServiceStep.Call("worker-to-tail#$number"),
                ServiceStep.Process(),
                ServiceStep.Call("worker-to-tail#$number"),
            )
            val copy = graph.calls.single { it.path == "worker-to-tail#$number" }
            assertThat(copy.pathSegments).containsExactly("worker-to-tail", "#$number")
            assertThat(copy.from).isEqualTo(instance.path)
            assertThat(copy.to).isEqualTo("tail#lb")
            assertThat(copy.origin.pointer).isEqualTo("/connections/2")
        }
    }

    @Test
    fun `one replica leaves service paths intact and warns about ignored balancing`() {
        val compiled = compile(model(1))
        val graph =
            requireNotNull(compiled.experiment)
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(graph.routers).isEmpty()
        assertThat(graph.services.map { it.path }).containsExactly("gateway", "worker", "tail")
        assertThat(graph.calls.map { it.path }).containsExactly("gateway-to-worker", "worker-to-tail")
        assertThat(ModelLinter().lint(requireNotNull(compiled.experiment))).anySatisfy {
            assertThat(it.code).isEqualTo("LINT_BALANCING_IGNORED")
            assertThat(it.pointer).isEqualTo("/connections/1/params/balancing")
        }
    }

    @Test
    fun `replica overrides merge partial nested parameters and affect only that instance`() {
        val graph = graph(model(3, overrides = """, "replicaOverrides":{"2":{"handlers":7,"processing":{"mean":"9ms"}}}"""))
        assertThat(graph.services.filter { it.path.startsWith("worker#") }.map { it.handlers }).containsExactly(2, 7, 2)
        assertThat(graph.services.filter { it.path.startsWith("worker#") }.map { it.processing.meanMs }).containsExactly(2.0, 9.0, 2.0)
    }

    @Test
    fun `invalid replica overrides locate the group and identify its replica`() {
        val result = compile(model(3, overrides = """, "replicaOverrides":{"2":{"handlers":0}}"""))
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.code).isEqualTo("PARAM_RANGE")
            assertThat(it.pointer).isEqualTo("/blocks/worker/replicaOverrides/2/handlers")
            assertThat(it.path).isEqualTo("worker#2")
            assertThat(it.args).containsEntry("replica", JsonPrimitive(2))
        }
        for (number in listOf("0", "01", "4")) {
            val invalid = compile(model(3, overrides = """, "replicaOverrides":{"$number":{"handlers":7}}"""))
            assertThat(invalid.experiment).isNull()
            assertThat(invalid.diagnostics.map { it.code }).contains("REPLICA_INDEX")
        }
    }

    @Test
    fun `faults bind after variant overrides to all group instances and connection copies`() {
        val experiment =
            experiment(
                """[{"target":"worker","from":"0ms","to":"1s","processingMultiplier":2},{"target":"worker-to-tail","from":"0ms","to":"1s","processingMultiplier":3}]""",
            )
        val graph = graph(model(3), experiment)
        assertThat(graph.faults.map { it.target }).containsExactly(
            "worker#1",
            "worker#2",
            "worker#3",
            "worker-to-tail#1",
            "worker-to-tail#2",
            "worker-to-tail#3",
        )
        val replica = experiment("""[{"target":"worker#2","from":"0ms","to":"1s","processingMultiplier":5}]""")
        val expanded =
            graph(
                model(1),
                replica.copy(
                    variants =
                        listOf(
                            Variant(
                                "baseline",
                                overrides =
                                    mapOf(
                                        "worker.replicas" to JsonPrimitive(3),
                                    ),
                            ),
                        ),
                ),
            )
        assertThat(expanded.faults.single().targetSegments).containsExactly("worker", "#2")
        val invalid = compile(model(3), replica.copy(faults = replica.faults.map { it.copy(target = "worker#4") }))
        assertThat(invalid.diagnostics.map { it.code }).contains("FAULT_TARGET")
    }

    @Test
    fun `replica counts support variants and grid and increase storage cost`() {
        val experiment = experiment().copy(grid = listOf(GridAxis("worker.replicas", listOf(2, 3, 4).map(::JsonPrimitive))))
        val compiled = requireNotNull(compile(model(1), experiment).experiment)
        val points = compiled.variants.single().points
        assertThat(points.map { point -> point.graph.services.count { it.path.startsWith("worker#") } }).containsExactly(2, 3, 4)
        val rows =
            points.map { point ->
                CostEstimator.estimate(compiled.copy(variants = compiled.variants.map { it.copy(points = listOf(point)) }), 1).expectedRows
            }
        assertThat(rows.zipWithNext().all { (left, right) -> left < right }).isTrue()
    }

    @Test
    fun `adding replicas preserves every existing stream address`() {
        val experiment = experiment("""[{"target":"worker-to-tail","from":"0ms","to":"1s","failureRate":"5%"}]""")
        val first = graph(model(3), experiment)
        val larger = graph(model(5), experiment)
        val originalKeys = PathStreams.keys(first, 0)
        val largerKeys = PathStreams.keys(larger, 0)
        assertThat(largerKeys).containsAll(originalKeys)
        val originalPlan = StreamPlan(originalKeys)
        val largerPlan = StreamPlan(largerKeys)
        originalKeys.forEach { assertThat(largerPlan.address(it)).isEqualTo(originalPlan.address(it)) }
    }

    @Test
    fun `replica warnings retain variant origins and prefer per-replica parameter origins`() {
        val source =
            model(3, overrides = """, "replicaOverrides":{"2":{"handlers":1}}""").let { model ->
                val worker = model.blocks.getValue("worker")
                model.copy(
                    blocks =
                        model.blocks + (
                            "worker" to
                                worker.copy(
                                    params =
                                        JsonObject(
                                            worker.params +
                                                mapOf(
                                                    "handlers" to JsonPrimitive(100),
                                                    "processing" to
                                                        JsonObject(
                                                            mapOf("kind" to JsonPrimitive("fixed"), "mean" to JsonPrimitive("200ms")),
                                                        ),
                                                ),
                                        ),
                                )
                        ),
                )
            }
        val experiment =
            experiment().copy(
                variants = listOf(Variant("candidate", overrides = mapOf("worker.handlers" to JsonPrimitive(1)))),
            )
        val compiled = requireNotNull(compile(source, experiment).experiment)
        val warnings = ModelLinter().lint(compiled).filter { it.code == "LINT_HANDLERS_LITTLE" }
        val inherited = warnings.single { it.path == "worker#1" }
        assertThat(inherited.document).isEqualTo("e.experiment.json")
        assertThat(inherited.pointer).isEqualTo("/variants/0/overrides/worker.handlers")
        assertThat(inherited.variant).isEqualTo("candidate")
        val specific = warnings.single { it.path == "worker#2" }
        assertThat(specific.document).isEqualTo("m.model.json")
        assertThat(specific.pointer).isEqualTo("/blocks/worker/replicaOverrides/2/handlers")
    }

    @Test
    fun `incoming calls retain their own policy including the default`() {
        val source =
            model(3).let { model ->
                val gateway = model.blocks.getValue("gateway")
                val call = model.connections.first { it.id == "gateway-to-worker" }
                model.copy(
                    blocks =
                        model.blocks + (
                            "gateway" to
                                gateway.copy(
                                    scenario =
                                        listOf(
                                            resiliencelab.core.document.ScenarioStep("call", connection = call.id),
                                            resiliencelab.core.document.ScenarioStep("call", connection = "second"),
                                        ),
                                )
                        ),
                    connections = model.connections + call.copy(id = "second", params = JsonObject(call.params - "balancing")),
                )
            }
        val graph = graph(source)
        assertThat(graph.calls.single { it.path == "gateway-to-worker" }.balancing).isEqualTo(RoutingPolicy.RANDOM)
        assertThat(graph.calls.single { it.path == "second" }.balancing).isEqualTo(RoutingPolicy.ROUND_ROBIN)
    }

    @Test
    fun `invalid counts and balancing are reported at catalog parameters`() {
        for (count in listOf(JsonPrimitive(0), JsonPrimitive(-1), JsonPrimitive(1.5), JsonPrimitive("3"))) {
            val source =
                model(1).let { model ->
                    val block = model.blocks.getValue("worker")
                    model.copy(blocks = model.blocks + ("worker" to block.copy(params = JsonObject(block.params + ("replicas" to count)))))
                }
            val result = compile(source)
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains("/blocks/worker/params/replicas")
        }
        val source =
            model(3).let { model ->
                model.copy(
                    connections =
                        model.connections.map {
                            it.copy(
                                params =
                                    if (it.type ==
                                        "call"
                                    ) {
                                        JsonObject(it.params + ("balancing" to JsonPrimitive("unknown")))
                                    } else {
                                        it.params
                                    },
                            )
                        },
                )
            }
        assertThat(compile(source).diagnostics.map { it.code }).contains("PARAM_TYPE")
    }

    internal fun model(
        replicas: Int,
        tailReplicas: Int = 1,
        overrides: String = "",
    ): ModelFile =
        (
            DocumentCodec.decodeModel(
                """{"schemaVersion":4,"blocks":{
              "client":{"type":"client","params":{"load": {"points": [{"time": "0s", "rate": "10/s"}]},"deadline":"1s"}},
              "gateway":{"type":"service","params":{"handlers":2,"processing":{"kind":"fixed","mean":"1ms"}}},
              "worker":{"type":"service","params":{"replicas":$replicas,"handlers":2,"processing":{"kind":"fixed","mean":"2ms"}},
                "scenario":[{"type":"process"},{"type":"call","connection":"worker-to-tail"},{"type":"process"},{"type":"call","connection":"worker-to-tail"}]$overrides},
              "tail":{"type":"service","params":{"replicas":$tailReplicas,"handlers":2,"processing":{"kind":"fixed","mean":"3ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"gateway"},
              {"id":"gateway-to-worker","type":"call","from":"gateway","to":"worker","params":{"timeout":"100ms","balancing":"random"}},
              {"id":"worker-to-tail","type":"call","from":"worker","to":"tail","params":{"timeout":"100ms"}}
            ]}""",
                "m.model.json",
            ) as DecodeResult.Ok
        ).value

    internal fun experiment(faults: String = "[]"): ExperimentFile =
        (
            DocumentCodec.decodeExperiment(
                """{"schemaVersion":1,"modelRef":"m.model.json","execution":{"replications":5,"warmup":"0ms","measurement":"1s","seed":42},"faults":$faults,"variants":[{"id":"baseline"}]}""",
                "e.experiment.json",
            ) as DecodeResult.Ok
        ).value

    internal fun compile(
        model: ModelFile,
        experiment: ExperimentFile = experiment(),
    ) = ModelCompiler().compile(model, "m.model.json", experiment, "e.experiment.json")

    internal fun graph(
        model: ModelFile,
        experiment: ExperimentFile = experiment(),
    ) = compile(model, experiment).let { result ->
        assertThat(result.diagnostics).isEmpty()
        requireNotNull(result.experiment)
            .variants
            .single()
            .points
            .single()
            .graph
    }
}
