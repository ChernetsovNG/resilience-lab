package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExecutionSettings
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Variant
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class ScenarioDocumentTest {
    private val experiment =
        ExperimentFile(
            1,
            modelRef = "m.model.json",
            execution = ExecutionSettings(5, "0ms", "1s", 42),
            variants = listOf(Variant("baseline")),
        )

    private val defaultScenario =
        """[
          {"type":"process"},
          {"type":"call","connection":"db"},
          {"type":"call","connection":"payment"},
          {"type":"call","connection":"db"}
        ]"""

    private fun model(scenario: String? = defaultScenario): ModelFile {
        val field = scenario?.let { ",\"scenario\":$it" }.orEmpty()
        val decoded =
            DocumentCodec.decodeModel(
                """{"schemaVersion":3,"blocks":{
              "client":{"type":"client","params":{"rate":"10/s","deadline":"1s"}},
              "order":{"type":"service","params":{"handlers":10,"processing":{"kind":"fixed","mean":"2ms"}}$field},
              "database":{"type":"service","params":{"handlers":10,"processing":{"kind":"fixed","mean":"1ms"}}},
              "psp":{"type":"service","params":{"handlers":10,"processing":{"kind":"fixed","mean":"1ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"order"},
              {"id":"db","type":"call","from":"order","to":"database","params":{"timeout":"100ms"}},
              {"id":"payment","type":"call","from":"order","to":"psp","params":{"timeout":"100ms"}}
            ]}""",
                "m.model.json",
            )
        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        return (decoded as DecodeResult.Ok).value
    }

    private fun compile(source: ModelFile) = ModelCompiler().compile(source, "m.model.json", experiment, "e.experiment.json")

    @Test
    fun `document scenario preserves ordered repeated calls through canonical round trip and compilation`() {
        val source = model()
        val encoded = DocumentCodec.encodeModel(source)
        val decoded = (DocumentCodec.decodeModel(encoded, "m.model.json") as DecodeResult.Ok).value
        assertThat(decoded).isEqualTo(source)
        val result = compile(decoded)
        assertThat(result.diagnostics).isEmpty()
        val graph =
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(
            graph.services
                .first()
                .scenario!!
                .filterIsInstance<ServiceStep.Call>()
                .map { it.edge },
        ).containsExactly("db", "payment", "db")
        assertThat(Json.parseToJsonElement(encoded).jsonObject["schemaVersion"]).isEqualTo(JsonPrimitive(3))
    }

    @Test
    fun `invalid call references point at their scenario step`() {
        for (connection in listOf("request", "missing")) {
            val result = compile(model("""[{"type":"call","connection":"$connection"}]"""))
            assertThat(result.experiment).isNull()
            val diagnostic = result.diagnostics.single()
            assertThat(diagnostic.code).isEqualTo("SCENARIO_CONNECTION")
            assertThat(diagnostic.pointer).isEqualTo("/blocks/order/scenario/0/connection")
            assertThat(diagnostic.path).isEqualTo("order")
            assertThat(diagnostic.args).containsEntry("connection", JsonPrimitive(connection))
        }
    }

    @Test
    fun `empty scenario and missing scenario for multiple calls are errors`() {
        val empty = compile(model("[]")).diagnostics.single()
        assertThat(empty.code).isEqualTo("SCENARIO_EMPTY")
        assertThat(empty.pointer).isEqualTo("/blocks/order/scenario")
        val missing = compile(model(null)).diagnostics.single()
        assertThat(missing.code).isEqualTo("SCENARIO_REQUIRED")
        assertThat(missing.pointer).isEqualTo("/blocks/order")
    }

    @Test
    fun `unused outgoing connection is a non blocking linter warning at the scenario`() {
        val result = compile(model("""[{"type":"call","connection":"db"}]"""))
        assertThat(result.diagnostics).isEmpty()
        val warning = ModelLinter().lint(result.experiment!!).single { it.code == "LINT_SCENARIO_UNUSED" }
        assertThat(warning.severity).isEqualTo(Severity.WARNING)
        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/blocks/order/scenario")
        assertThat(warning.args).containsEntry("connection", JsonPrimitive("payment"))
    }

    @Test
    fun `rejects unknown step kinds and wrong fields`() {
        for (step in listOf(
            """{"type":"parallel"}""",
            """{"type":"call"}""",
            """{"type":"call","connection":"db","failureRate":"0%"}""",
            """{"type":"process","connection":"db"}""",
        )) {
            val result = compile(model("[$step]"))
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics).allSatisfy { assertThat(it.pointer).startsWith("/blocks/order/scenario/0") }
        }
    }

    @Test
    fun `scenario executes db payment db and uses process overrides`() {
        val source =
            model(
                """[{"type":"process","processing":{"kind":"fixed","mean":"4ms"},"failureRate":"0%"},{"type":"call","connection":"db"},{"type":"call","connection":"payment"},{"type":"call","connection":"db"}]""",
            )
        val compiled = compile(source).experiment!!
        val result = ExperimentExecutor(1).use { it.run(compiled) }
        result.variants.single().points.single().replications.forEach { replication ->
            assertThat(replication.originalArrivals).isPositive()
            assertThat(replication.successes).isEqualTo(replication.originalArrivals)
            assertThat(replication.allLatency.sumMs).isCloseTo(7.0 * replication.originalArrivals, offset(1e-9))
            assertThat(replication.connections.getValue("db").sentAttempts).isEqualTo(2 * replication.originalArrivals)
            assertThat(replication.connections.getValue("payment").sentAttempts).isEqualTo(replication.originalArrivals)
            assertThat(replication.connections.getValue("db").retries).isZero()
        }
    }

    @Test
    fun `process inherits effective service parameters but explicit values take precedence`() {
        val base = model("""[{"type":"process"}]""")
        val overridden =
            experiment.copy(
                variants =
                    listOf(
                        Variant(
                            "baseline",
                            overrides =
                                mapOf(
                                    "order.processing.mean" to JsonPrimitive("5ms"),
                                    "order.failureRate" to JsonPrimitive("100%"),
                                ),
                        ),
                    ),
            )
        val inherited = ModelCompiler().compile(base, "m.model.json", overridden, "e.experiment.json").experiment!!
        val explicit =
            ModelCompiler()
                .compile(
                    model("""[{"type":"process","processing":{"kind":"fixed","mean":"3ms"},"failureRate":"0%"}]"""),
                    "m.model.json",
                    overridden,
                    "e.experiment.json",
                ).experiment!!
        for ((compiled, duration, succeeds) in listOf(Triple(inherited, 5.0, false), Triple(explicit, 3.0, true))) {
            ExperimentExecutor(1).use { it.run(compiled) }.variants.single().points.single().replications.forEach { replication ->
                assertThat(replication.successes).isEqualTo(if (succeeds) replication.originalArrivals else 0)
                assertThat(replication.allLatency.sumMs).isCloseTo(duration * replication.originalArrivals, offset(1e-9))
            }
        }
    }

    @Test
    fun `each processing step uses its own duration and a local failure aborts following calls`() {
        val source =
            model(
                """[
          {"type":"process","processing":{"kind":"fixed","mean":"3ms"}},
          {"type":"process","processing":{"kind":"fixed","mean":"4ms"},"failureRate":"100%"},
          {"type":"call","connection":"db"}
        ]""",
            )
        val run = ExperimentExecutor(1).use { it.run(compile(source).experiment!!) }
        run.variants.single().points.single().replications.forEach { result ->
            assertThat(result.originalArrivals).isPositive()
            assertThat(result.failures).isEqualTo(result.originalArrivals)
            assertThat(result.allLatency.sumMs).isCloseTo(7.0 * result.originalArrivals, offset(1e-9))
            assertThat(result.connections.values).allSatisfy { assertThat(it.sentAttempts).isZero() }
        }
    }

    @Test
    fun `invalid processing values retain step pointers and calls cannot reference another service edge`() {
        val invalid = compile(model("""[{"type":"process","processing":{"kind":"lognormal","mean":"0ms"},"failureRate":"101%"}]"""))
        assertThat(invalid.experiment).isNull()
        assertThat(invalid.diagnostics.map { it.pointer }).containsExactlyInAnyOrder(
            "/blocks/order/scenario/0/processing/mean",
            "/blocks/order/scenario/0/processing/stdDev",
            "/blocks/order/scenario/0/failureRate",
        )
        val source = model("""[{"type":"call","connection":"foreign"}]""")
        val foreign = source.connections.last().copy(id = "foreign", from = "database")
        val result = compile(source.copy(connections = source.connections + foreign))
        assertThat(result.diagnostics.single().code).isEqualTo("SCENARIO_CONNECTION")
        assertThat(result.diagnostics.single().pointer).isEqualTo("/blocks/order/scenario/0/connection")
    }

    @Test
    fun `scenario is service structure and cannot be overridden as a parameter`() {
        val base = model()
        val client = base.blocks.getValue("client").copy(scenario = base.blocks.getValue("order").scenario)
        val result = compile(base.copy(blocks = base.blocks + ("client" to client)))
        assertThat(result.diagnostics.single().code).isEqualTo("SCENARIO_BLOCK")
        assertThat(result.diagnostics.single().pointer).isEqualTo("/blocks/client/scenario")
        val overridden = experiment.copy(variants = listOf(Variant("baseline", overrides = mapOf("order.scenario" to JsonPrimitive("x")))))
        val rejected = ModelCompiler().compile(base, "m.model.json", overridden, "e.experiment.json")
        assertThat(rejected.diagnostics.single().code).isEqualTo("OVERRIDE_PATH")
    }

    @Test
    fun `document scenario results ignore workers task order and block and connection order`() {
        val source =
            model(
                defaultScenario.replace(
                    "{\"type\":\"process\"}",
                    """{"type":"process","processing":{"kind":"exponential","mean":"3ms"},"failureRate":"10%"}""",
                ),
            )
        val multiVariant =
            experiment.copy(
                variants =
                    listOf(
                        Variant("baseline"),
                        Variant(
                            "candidate",
                            overrides =
                                mapOf(
                                    "db.attempts" to JsonPrimitive(2),
                                ),
                        ),
                    ),
            )

        fun run(
            workers: Int,
            reversed: Boolean,
        ): List<String> {
            val document =
                if (reversed) {
                    source.copy(
                        blocks =
                            source.blocks.entries.reversed().associate {
                                it.toPair()
                            },
                        connections = source.connections.reversed(),
                    )
                } else {
                    source
                }
            val settings = if (reversed) multiVariant.copy(variants = multiVariant.variants.reversed()) else multiVariant
            val compiled = ModelCompiler().compile(document, "m.model.json", settings, "e.experiment.json").experiment!!
            return ExperimentExecutor(workers).use { it.run(compiled) }.variants.sortedBy { it.id }.flatMap { variant ->
                variant.points.single().replications.map {
                    DocumentCodec.encode(
                        resiliencelab.core.experiment.ReplicationResult
                            .serializer(),
                        it,
                    )
                }
            }
        }
        val expected = run(1, false)
        for (workers in listOf(1, 2, 4, 8)) {
            assertThat(run(workers, true)).describedAs("workers=$workers; reversed documents and tasks").isEqualTo(expected)
        }
    }
}
