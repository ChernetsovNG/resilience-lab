package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ModelFile
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class GraphCompilerTest {
    private val model =
        (
            DocumentCodec.decodeModel(
                """{"schemaVersion":5,"blocks":{
          "client":{"type":"client","params":{"load": {"points": [{"time": "0s", "rate": "10/s"}]},"deadline":"1s"}},
          "z-entry":{"type":"service","params":{"handlers":2,"queue":2,"processing":{"kind":"fixed","mean":"1ms"}}},
          "a-leaf":{"type":"service","params":{"handlers":2,"queue":2,"processing":{"kind":"fixed","mean":"1ms"}}}
        },"connections":[
          {"id":"request","type":"request","from":"client","to":"z-entry"},
          {"id":"z-call","type":"call","from":"z-entry","to":"a-leaf","params":{"timeout":"10ms"}}
        ]}""",
                "m.model.json",
            ) as DecodeResult.Ok
        ).value
    private val experiment =
        (
            DocumentCodec.decodeExperiment(
                """{"schemaVersion":1,"modelRef":"m.model.json","execution":{"replications":5,"warmup":"0ms","measurement":"1s","seed":42},"variants":[{"id":"baseline"}]}""",
                "e.experiment.json",
            ) as DecodeResult.Ok
        ).value

    private fun compile(source: ModelFile = model) = ModelCompiler().compile(source, "m.model.json", experiment, "e.experiment.json")

    @Test
    fun `orders services from client rather than alphabetically`() {
        val result = compile()
        assertThat(result.diagnostics).isEmpty()
        assertThat(
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph.services
                .map { it.path },
        ).containsExactly("z-entry", "a-leaf")
    }

    @Test
    fun `cycle diagnostic names every member and points at its closing call`() {
        val back = model.connections.last().copy(id = "back", from = "a-leaf", to = "z-entry")
        val result = compile(model.copy(connections = model.connections + back))
        assertThat(result.experiment).isNull()
        val cycle = result.diagnostics.single { it.code == "TOPOLOGY_GRAPH" && it.args?.get("reason") == JsonPrimitive("cycle") }
        assertThat(cycle.message).contains("a-leaf", "z-entry", "back", "z-call")
        assertThat(cycle.document).isEqualTo("m.model.json")
        assertThat(cycle.pointer).isIn("/connections/1", "/connections/2")
    }

    @Test
    fun `unreachable node has a graph diagnostic at its block`() {
        val result = compile(model.copy(blocks = model.blocks + ("orphan" to model.blocks.getValue("a-leaf"))))
        val diagnostic = result.diagnostics.single()
        assertThat(diagnostic.code).isEqualTo("TOPOLOGY_GRAPH")
        assertThat(diagnostic.args).containsEntry("reason", JsonPrimitive("unreachable"))
        assertThat(diagnostic.pointer).isEqualTo("/blocks/orphan")
    }

    @Test
    fun `two clients are rejected at the block collection`() {
        val result = compile(model.copy(blocks = model.blocks + ("client2" to model.blocks.getValue("client"))))
        val diagnostic = result.diagnostics.single()
        assertThat(diagnostic.code).isEqualTo("TOPOLOGY_CLIENT")
        assertThat(diagnostic.pointer).isEqualTo("/blocks")
        assertThat(diagnostic.args).containsEntry("found", JsonPrimitive(2))
    }

    @Test
    fun `call into entry is rejected at the connection`() {
        val back = model.connections.last().copy(id = "back", from = "a-leaf", to = "z-entry")
        val result = compile(model.copy(connections = model.connections + back))
        val diagnostic = result.diagnostics.single { it.args?.get("reason") == JsonPrimitive("entry") }
        assertThat(diagnostic.code).isEqualTo("TOPOLOGY_GRAPH")
        assertThat(diagnostic.pointer).isEqualTo("/connections/2/to")
    }

    @Test
    fun `multiple incoming calls are allowed but branching requires a scenario`() {
        val first = model.connections.last()
        val result = compile(model.copy(connections = model.connections + first.copy(id = "another")))
        assertThat(result.diagnostics).hasSize(1)
        val diagnostic = result.diagnostics.single()
        assertThat(diagnostic.code).isEqualTo("SCENARIO_REQUIRED")
        assertThat(diagnostic.pointer).isEqualTo("/blocks/z-entry")
        assertThat(diagnostic.args).containsEntry("service", JsonPrimitive("z-entry"))
    }

    @Test
    fun `compiler materializes the stage one scenario and stable instance paths`() {
        val graph =
            compile()
                .experiment!!
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(graph.services.first().scenario)
            .containsExactly(ServiceStep.Process(), ServiceStep.Call("z-call"))
        assertThat(graph.services.last().scenario).containsExactly(ServiceStep.Process())
        assertThat(graph.client.pathSegments).containsExactly("client")
        assertThat(graph.services.first().pathSegments).containsExactly("z-entry")
        assertThat(graph.calls.single().pathSegments).containsExactly("z-call")
    }
}
