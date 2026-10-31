package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Variant
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.Origin
import kotlin.test.Test

class FaultCompilerTest {
    @Test
    fun `binds every fault kind to blocks replica instances calls and routes`() {
        val result =
            compile(
                """[
                  {"target":"worker","from":"0ms","to":"1s","kind":"slowdown","multiplier":2,"delay":"200ms"},
                  {"target":"worker#2","from":"0ms","to":"1s","kind":"unavailable"},
                  {"target":"worker-to-pooler","from":"0ms","to":"1s","kind":"blackhole"},
                  {"target":"worker-to-pooler#2","from":"0ms","to":"1s","kind":"errors","failureRate":"25%"},
                  {"target":"router-to-worker","from":"0ms","to":"1s","kind":"errors","failureRate":"5%"},
                  {"target":"db","from":"0ms","to":"1s","kind":"capacityLoss","capacity":0},
                  {"target":"pooler","from":"0ms","to":"1s","kind":"capacityLoss","capacity":1},
                  {"target":"gateway-to-router","from":"0ms","to":"1s","kind":"capacityLoss","capacity":2}
                ]""",
            )

        assertThat(result.diagnostics).isEmpty()
        val faults = graph(result).faults
        assertThat(faults.map { it.target }).containsExactly(
            "db",
            "gateway-to-router",
            "pooler",
            "router-to-worker",
            "worker#1",
            "worker#2",
            "worker#2",
            "worker-to-pooler#1",
            "worker-to-pooler#2",
            "worker-to-pooler#2",
        )
        assertThat(faults.map { it.kind }).containsExactly(
            FaultKind.CAPACITY_LOSS,
            FaultKind.CAPACITY_LOSS,
            FaultKind.CAPACITY_LOSS,
            FaultKind.ERRORS,
            FaultKind.SLOWDOWN,
            FaultKind.SLOWDOWN,
            FaultKind.UNAVAILABLE,
            FaultKind.BLACKHOLE,
            FaultKind.ERRORS,
            FaultKind.BLACKHOLE,
        )
        assertThat(faults.filter { it.kind == FaultKind.SLOWDOWN }).allSatisfy {
            assertThat(it.multiplier).isEqualTo(2.0)
            assertThat(it.delayMs).isEqualTo(200.0)
        }
        assertThat(faults.filter { it.kind == FaultKind.CAPACITY_LOSS }.map { it.capacity }).containsExactly(0, 2, 1)
        assertThat(faults.filter { it.target == "worker#2" }).allSatisfy {
            assertThat(it.targetSegments).containsExactly("worker", "#2")
        }
        assertThat(faults.single { it.failureProbability == 0.25 }.targetSegments).containsExactly("worker-to-pooler", "#2")
    }

    @Test
    fun `rejects unknown kinds fields that do not apply and missing kind parameters`() {
        for ((fields, code, pointer) in listOf(
            Triple("\"kind\":\"periodic\"", "FAULT_KIND", "/kind"),
            Triple("\"kind\":\"slowdown\"", "FAULT_EMPTY", ""),
            Triple("\"kind\":\"errors\"", "PARAM_MISSING", "/failureRate"),
            Triple("\"kind\":\"capacityLoss\"", "PARAM_MISSING", "/capacity"),
            Triple("\"kind\":\"errors\",\"failureRate\":\"5%\",\"multiplier\":2", "FAULT_FIELD", "/multiplier"),
            Triple("\"kind\":\"capacityLoss\",\"capacity\":0,\"delay\":\"1ms\"", "FAULT_FIELD", "/delay"),
            Triple("\"kind\":\"unavailable\",\"failureRate\":\"5%\"", "FAULT_FIELD", "/failureRate"),
            Triple("\"kind\":\"blackhole\",\"capacity\":0", "FAULT_FIELD", "/capacity"),
        )) {
            val result = compile("""[{"target":"worker","from":"0ms","to":"1s",$fields}]""")
            assertThat(result.experiment).describedAs(fields).isNull()
            assertThat(result.diagnostics.map { it.code to it.pointer }).describedAs(fields).contains(code to "/faults/0$pointer")
        }
    }

    @Test
    fun `rejects missing client router request and invalid replica targets`() {
        for (target in listOf("missing", "client", "router", "request", "worker#0", "worker#3", "worker-to-pooler#3")) {
            val result = compile("""[{"target":"$target","from":"0ms","to":"1s","kind":"unavailable"}]""")
            assertThat(result.experiment).describedAs(target).isNull()
            assertThat(result.diagnostics.map { it.code to it.pointer }).contains("FAULT_TARGET" to "/faults/0/target")
        }
    }

    @Test
    fun `checks finite positive multipliers nonnegative delays and probability range`() {
        for ((fields, pointer) in listOf(
            "\"kind\":\"slowdown\",\"multiplier\":0" to "/multiplier",
            "\"kind\":\"slowdown\",\"multiplier\":-1" to "/multiplier",
            "\"kind\":\"slowdown\",\"delay\":\"-1ms\"" to "/delay",
            "\"kind\":\"slowdown\",\"delay\":\"1/s\"" to "/delay",
            "\"kind\":\"errors\",\"failureRate\":\"101%\"" to "/failureRate",
            "\"kind\":\"capacityLoss\",\"capacity\":-1" to "/capacity",
        )) {
            val result = compile("""[{"target":"worker","from":"0ms","to":"1s",$fields}]""")
            assertThat(result.experiment).describedAs(fields).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains("/faults/0$pointer")
        }
        assertThat(compile("""[{"target":"worker","from":"0ms","to":"1s","kind":"slowdown","delay":"0ms"}]""").diagnostics)
            .isEmpty()
    }

    @Test
    fun `checks intervals against warmup plus measurement and permits exact run boundaries`() {
        for ((from, to) in listOf("0ms" to "0ms", "500ms" to "500ms", "1s" to "2s", "0ms" to "2001ms")) {
            val result = compile("""[{"target":"worker","from":"$from","to":"$to","kind":"unavailable"}]""")
            assertThat(result.experiment).describedAs("[$from,$to)").isNull()
            assertThat(result.diagnostics.map { it.code }).contains("FAULT_INTERVAL")
        }
        val fullRun = compile("""[{"target":"worker","from":"0ms","to":"2s","kind":"unavailable"}]""", warmup = "1s")
        assertThat(fullRun.diagnostics).isEmpty()
    }

    @Test
    fun `capacity loss uses the effective node and call pool capacity for every variant`() {
        for ((target, capacity) in listOf("worker" to 5, "worker#2" to 5, "db" to 5, "pooler" to 3, "gateway-to-router" to 4)) {
            val result = compile("""[{"target":"$target","from":"0ms","to":"1s","kind":"capacityLoss","capacity":$capacity}]""")
            assertThat(result.experiment).describedAs(target).isNull()
            assertThat(result.diagnostics.map { it.code to it.pointer }).contains("PARAM_RANGE" to "/faults/0/capacity")
        }
        for (target in listOf("router-to-worker", "pooler-to-db")) {
            val result = compile("""[{"target":"$target","from":"0ms","to":"1s","kind":"capacityLoss","capacity":0}]""")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code to it.pointer }).contains("FAULT_CAPACITY_TARGET" to "/faults/0/target")
        }
        val source = experiment("""[{"target":"worker-to-pooler","from":"0ms","to":"1s","kind":"capacityLoss","capacity":2}]""")
        val overridden =
            source.copy(
                variants =
                    listOf(
                        Variant("baseline"),
                        Variant("smaller", overrides = mapOf("worker-to-pooler.pool.size" to JsonPrimitive(1))),
                    ),
            )
        val result = ModelCompiler().compile(model(), "m.model.json", overridden, "e.experiment.json")
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics).allSatisfy {
            assertThat(it.code).isEqualTo("PARAM_RANGE")
            assertThat(it.variant).isEqualTo("smaller")
            assertThat(it.pointer).isEqualTo("/faults/0/capacity")
        }
    }

    @Test
    fun `capacity of a group is checked against each replica override`() {
        val source = model()
        val worker = source.blocks.getValue("worker")
        val patched =
            source.copy(
                blocks =
                    source.blocks + (
                        "worker" to
                            worker.copy(
                                replicaOverrides = mapOf("2" to JsonObject(mapOf("handlers" to JsonPrimitive(1)))),
                            )
                    ),
            )
        val faults = experiment("""[{"target":"worker","from":"0ms","to":"1s","kind":"capacityLoss","capacity":2}]""")

        val result = ModelCompiler().compile(patched, "m.model.json", faults, "e.experiment.json")

        assertThat(result.experiment).isNull()
        val diagnostic = result.diagnostics.single()
        assertThat(diagnostic.code to diagnostic.pointer).isEqualTo("PARAM_RANGE" to "/faults/0/capacity")
        assertThat(diagnostic.path).isEqualTo("worker#2")
        assertThat(diagnostic.args).containsEntry("maximum", JsonPrimitive(1))
    }

    @Test
    fun `overlap and tied fault ordering are independent of document order`() {
        val source =
            experiment(
                """[
                  {"target":"worker","from":"0ms","to":"900ms","kind":"slowdown","multiplier":3},
                  {"target":"worker","from":"0ms","to":"1s","kind":"slowdown","multiplier":2},
                  {"target":"worker","from":"0ms","to":"1s","kind":"slowdown","multiplier":3},
                  {"target":"worker","from":"0ms","to":"1s","kind":"errors","failureRate":"10%"},
                  {"target":"worker","from":"0ms","to":"1s","kind":"errors","failureRate":"20%"}
                ]""",
            )

        fun faults(experiment: ExperimentFile) =
            graph(ModelCompiler().compile(model(), "m.model.json", experiment, "e.experiment.json")).faults.map {
                it.copy(origin = Origin.UNSPECIFIED)
            }

        assertThat(faults(source.copy(faults = source.faults.reversed()))).containsExactlyElementsOf(faults(source))
    }

    private fun compile(
        faults: String,
        warmup: String = "0ms",
    ) = ModelCompiler().compile(model(), "m.model.json", experiment(faults, warmup), "e.experiment.json")

    private fun graph(result: CompileResult) =
        requireNotNull(result.experiment) { result.diagnostics.toString() }
            .variants
            .single()
            .points
            .single()
            .graph

    private fun experiment(
        faults: String,
        warmup: String = "0ms",
    ): ExperimentFile {
        val decoded =
            DocumentCodec.decodeExperiment(
                """{"schemaVersion":3,"modelRef":"m.model.json","execution":{"replications":1,"warmup":"$warmup","measurement":"1s","seed":1},"faults":$faults,"variants":[{"id":"baseline"}]}""",
                "e.experiment.json",
            )
        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        return (decoded as DecodeResult.Ok).value
    }

    private fun model(): ModelFile =
        (
            DocumentCodec.decodeModel(
                """{"schemaVersion":6,"blocks":{
                  "client":{"type":"client","params":{"load":{"points":[{"time":"0ms","rate":"10/s"}]},"deadline":"1s"}},
                  "gateway":{"type":"service","params":{"handlers":4,"processing":{"kind":"fixed","mean":"1ms"}}},
                  "router":{"type":"router"},
                  "worker":{"type":"service","params":{"replicas":2,"handlers":4,"processing":{"kind":"fixed","mean":"1ms"}}},
                  "pooler":{"type":"pooler","params":{"maxClientConnections":8,"poolSize":2,"waitTimeout":"100ms"}},
                  "db":{"type":"database","params":{"maxConnections":4,"processing":{"kind":"fixed","mean":"1ms"}}}
                },"connections":[
                  {"id":"request","type":"request","from":"client","to":"gateway"},
                  {"id":"gateway-to-router","type":"call","from":"gateway","to":"router","params":{"timeout":"100ms","pool":{"size":3}}},
                  {"id":"router-to-worker","type":"route","from":"router","to":"worker"},
                  {"id":"worker-to-pooler","type":"call","from":"worker","to":"pooler","params":{"timeout":"100ms","pool":{"size":2}}},
                  {"id":"pooler-to-db","type":"call","from":"pooler","to":"db","params":{"timeout":"100ms"}}
                ]}""",
                "m.model.json",
            ) as DecodeResult.Ok
        ).value
}
