package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec

class CallPoliciesCompilerTest {
    @Test
    fun `catalog exposes computable policy outputs`() {
        assertThat(
            Stage1Catalog.catalog
                .type("call")!!
                .outputs
                .map { it.id },
        ).contains(
            "circuitOpenShare",
            "circuitRejectionsPerSecond",
            "retriesDeniedPerSecond",
            "fallbacksPerSecond",
        )
        assertThat(
            Stage1Catalog.catalog
                .type("client")!!
                .outputs
                .map { it.id },
        ).contains("degradedPerSecond")
    }

    @Test
    fun `optional policies compile with their defaults when enabled`() {
        val result = compile(""""circuitBreaker":{},"retryBudget":{},"fallback":{}""")
        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isNotNull()
        val call =
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph.calls
                .single()
        assertThat(call.circuitBreaker?.minimumCalls).isEqualTo(10)
        assertThat(call.circuitBreaker?.failureRate).isEqualTo(0.5)
        assertThat(call.retryBudget?.minPerMs).isEqualTo(0.01)
        assertThat(call.fallback?.on).containsExactly("circuitOpen")
        assertThat(call.fallback?.processingMs).isEqualTo(1.0)
    }

    @Test
    fun `policy grids and nested overrides reach every calling replica`() {
        val result =
            compile(
                """"circuitBreaker":{},"retryBudget":{}""",
                mapOf("call.circuitBreaker.openDuration" to JsonPrimitive("7ms")),
                replicas = 2,
                grid = """[{"path":"call.retryBudget.ratio","values":["10%","30%"]}]""",
            )
        assertThat(result.diagnostics).isEmpty()
        val points =
            requireNotNull(result.experiment)
                .variants
                .single()
                .points
        assertThat(points.map { it.graph.calls.size }).containsExactly(2, 2)
        assertThat(points.flatMap { it.graph.calls }.map { it.circuitBreaker?.openDurationMs }).containsOnly(7.0)
        assertThat(
            points.map {
                it.graph.calls.map { call ->
                    call.retryBudget?.ratio
                }
            },
        ).containsExactly(listOf(0.1, 0.1), listOf(0.3, 0.3))
    }

    @Test
    fun `invalid policy parameters retain their nested pointers`() {
        for ((params, pointer) in listOf(
            """"circuitBreaker":{"failureRate":"101%"}""" to "circuitBreaker/failureRate",
            """"circuitBreaker":{"minimumCalls":0}""" to "circuitBreaker/minimumCalls",
            """"circuitBreaker":{"minimumCalls":21,"window":20}""" to "circuitBreaker/minimumCalls",
            """"circuitBreaker":{"window":0}""" to "circuitBreaker/window",
            """"circuitBreaker":{"openDuration":"0ms"}""" to "circuitBreaker/openDuration",
            """"circuitBreaker":{"halfOpenCalls":0}""" to "circuitBreaker/halfOpenCalls",
            """"retryBudget":{"ratio":"-1%"}""" to "retryBudget/ratio",
            """"retryBudget":{"minPerSecond":"-1/s"}""" to "retryBudget/minPerSecond",
            """"retryBudget":{"window":"0ms"}""" to "retryBudget/window",
            """"fallback":{"on":["deadline"]}""" to "fallback/on",
            """"fallback":{"on":["unknown"]}""" to "fallback/on",
            """"fallback":{"processing":"-1ms"}""" to "fallback/processing",
        )) {
            val result = compile(params)
            assertThat(result.experiment).describedAs(params).isNull()
            assertThat(result.diagnostics.map { it.pointer }).describedAs(params).contains("/connections/1/params/$pointer")
        }
    }

    @Test
    fun `invalid nested policy override points at the experiment`() {
        val result = compile(""""retryBudget":{}""", mapOf("call.retryBudget.ratio" to JsonPrimitive("101%")))
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.pointer }).contains("/variants/0/overrides/call.retryBudget.ratio")
    }

    private fun compile(
        params: String,
        overrides: Map<String, JsonElement> = emptyMap(),
        replicas: Int = 1,
        grid: String = "[]",
    ): CompileResult {
        val model =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":7,"blocks":{
                  "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"1/s"}]},"deadline":"1s"}},
                  "entry":{"type":"service","params":{"handlers":4,"replicas":$replicas,"processing":{"kind":"fixed","mean":"0ms"}}},
                  "backend":{"type":"service","params":{"handlers":4,"processing":{"kind":"fixed","mean":"5ms"}}}
                },"connections":[
                  {"id":"request","type":"request","from":"client","to":"entry"},
                  {"id":"call","type":"call","from":"entry","to":"backend","params":{"timeout":"10ms",$params}}
                ]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val experiment =
            (
                DocumentCodec.decodeExperiment(
                    """{"schemaVersion":4,"modelRef":"m.model.json","execution":{"replications":1,"warmup":"0ms","measurement":"100ms","seed":1},"variants":[{"id":"baseline"}],"grid":$grid}""",
                    "e.experiment.json",
                ) as DecodeResult.Ok
            ).value
        return ModelCompiler().compile(
            model,
            "m.model.json",
            experiment.copy(variants = experiment.variants.map { it.copy(overrides = overrides) }),
            "e.experiment.json",
        )
    }
}
