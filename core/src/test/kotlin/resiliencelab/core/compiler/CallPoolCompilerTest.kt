package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import kotlin.test.Test

class CallPoolCompilerTest {
    @Test
    fun `call accepts an optional pool with a default acquisition timeout`() {
        val result = compile("""{"size":2}""")
        assertThat(result.diagnostics).isEmpty()
        val pool =
            requireNotNull(result.experiment)
                .variants
                .single()
                .points
                .single()
                .graph.calls
                .single()
                .pool
        assertThat(pool?.size).isEqualTo(2)
        assertThat(pool?.acquireTimeoutMs).isEqualTo(30_000.0)
    }

    @Test
    fun `pool rejects invalid capacity duration and unknown fields with precise pointers`() {
        for ((pool, pointer) in listOf(
            """{"size":0}""" to "/size",
            """{"size":1.5}""" to "/size",
            """{}""" to "/size",
            """{"size":1,"acquireTimeout":"-1ms"}""" to "/acquireTimeout",
            """{"size":1,"acquireTimeout":"3/s"}""" to "/acquireTimeout",
            """{"size":1,"unknown":2}""" to "/unknown",
        )) {
            val result = compile(pool)
            assertThat(result.experiment).describedAs(pool).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains("/connections/1/params/pool$pointer")
        }
    }

    @Test
    fun `nested variant overrides reach every caller replica pool`() {
        val result =
            compile(
                """{"size":1}""",
                mapOf(
                    "call.pool.size" to JsonPrimitive(3),
                    "call.pool.acquireTimeout" to JsonPrimitive("2ms"),
                ),
                2,
            )
        assertThat(result.diagnostics).isEmpty()
        val calls =
            requireNotNull(result.experiment)
                .variants
                .single()
                .points
                .single()
                .graph.calls
        assertThat(calls).hasSize(2)
        assertThat(calls.map { it.pool?.size }).containsExactly(3, 3)
        assertThat(calls.map { it.pool?.acquireTimeoutMs }).containsExactly(2.0, 2.0)
    }

    @Test
    fun `invalid variant pool capacity points to its override`() {
        val result = compile("""{"size":1}""", mapOf("call.pool.size" to JsonPrimitive(0)))
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.pointer }).contains("/variants/0/overrides/call.pool.size")
    }

    private fun compile(
        pool: String,
        overrides: Map<String, JsonElement> = emptyMap(),
        replicas: Int = 1,
    ): CompileResult {
        val model =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":${DocumentCodec.MODEL_SCHEMA_VERSION},"blocks":{
              "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"1/s"}]},"deadline":"1s"}},
              "entry":{"type":"service","params":{"handlers":4,"replicas":$replicas,"processing":{"kind":"fixed","mean":"0ms"}}},
              "backend":{"type":"service","params":{"handlers":4,"processing":{"kind":"fixed","mean":"5ms"}}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"entry"},
              {"id":"call","type":"call","from":"entry","to":"backend","params":{"timeout":"10ms","pool":$pool}}
            ]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val experiment =
            (
                DocumentCodec.decodeExperiment(
                    """{"schemaVersion":2,"modelRef":"m.model.json","execution":{"replications":1,"warmup":"0ms","measurement":"100ms","seed":1},"variants":[{"id":"baseline"}]}""",
                    "e.experiment.json",
                ) as DecodeResult.Ok
            ).value
        return ModelCompiler().compile(
            model,
            "m.model.json",
            experiment.copy(
                variants =
                    experiment.variants.map {
                        it.copy(overrides = overrides)
                    },
            ),
            "e.experiment.json",
        )
    }
}
