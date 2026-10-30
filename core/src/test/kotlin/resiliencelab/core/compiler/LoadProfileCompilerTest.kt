package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import kotlin.test.Test

class LoadProfileCompilerTest {
    private fun compile(
        load: String,
        extra: String = "",
        variants: String = """[{"id":"baseline"}]""",
    ): CompileResult {
        val model =
            """
            {"schemaVersion": ${DocumentCodec.MODEL_SCHEMA_VERSION}, "blocks": {
              "client": {"type": "client", "params": {"load": $load, "deadline": "1s"}},
              "entry": {"type": "service", "params": {"handlers": 10, "processing": {"kind": "fixed", "mean": "1ms"}}}
            }, "connections": [{"id": "request", "type": "request", "from": "client", "to": "entry"}]}
            """.trimIndent()
        val experiment =
            """
            {"schemaVersion": 1, "modelRef": "m.model.json",
             "execution": {"replications": 5, "warmup": "0s", "measurement": "1s", "seed": 42},
             "variants": $variants $extra}
            """.trimIndent()
        return ModelCompiler().compile(
            (DocumentCodec.decodeModel(model, "m.model.json") as DecodeResult.Ok).value,
            "m.model.json",
            (DocumentCodec.decodeExperiment(experiment, "e.experiment.json") as DecodeResult.Ok).value,
            "e.experiment.json",
        )
    }

    @Test
    fun `constant profile replaces rate`() {
        val result = compile("""{"points":[{"time":"0s","rate":"120/s"}]}""")

        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isNotNull()
    }

    @Test
    fun `profile errors point to their document values`() {
        listOf(
            """{"points":[]}""" to "/blocks/client/params/load/points",
            """{"points":[{"time":"1s","rate":"2/s"},{"time":"0s","rate":"2/s"}]}""" to
                "/blocks/client/params/load/points/1/time",
            """{"points":[{"time":"0s","rate":"-2/s"}]}""" to "/blocks/client/params/load/points/0/rate",
            """{"points":[{"time":"-1ms","rate":"2/s"}]}""" to "/blocks/client/params/load/points/0/time",
            """{"points":[{"time":"0s","rate":"1/s"},{"time":"0s","rate":"2/s"}]}""" to
                "/blocks/client/params/load/points/1/time",
        ).forEach { (load, pointer) ->
            val result = compile(load)
            assertThat(result.experiment).describedAs(load).isNull()
            assertThat(result.diagnostics).describedAs(load).anySatisfy {
                assertThat(it.document).isEqualTo("m.model.json")
                assertThat(it.pointer).isEqualTo(pointer)
            }
        }
    }

    @Test
    fun `load profiles cannot be swept in a grid`() {
        listOf(
            "client.load" to """{"points":[{"time":"0s","rate":"30/s"}]}""",
            "client.load.points" to """[{"time":"0s","rate":"30/s"}]""",
        ).forEach { (path, value) ->
            val result =
                compile(
                    """{"points":[{"time":"0s","rate":"20/s"}]}""",
                    """, "grid":[{"path":"$path","values":[$value]}]""",
                )
            assertThat(result.experiment).isNull()
            val diagnostic = result.diagnostics.single { it.code == "GRID_PATH" }
            assertThat(diagnostic.document).isEqualTo("e.experiment.json")
            assertThat(diagnostic.pointer).isEqualTo("/grid/0/path")
            assertThat(diagnostic.args).containsEntry("path", JsonPrimitive(path))
        }
    }

    @Test
    fun `different profiles are compared by variant overrides`() {
        val result =
            compile(
                """{"points":[{"time":"0s","rate":"20/s"}]}""",
                variants = """[{"id":"baseline"},{"id":"ramp","overrides":{
                "client.load":{"points":[{"time":"0s","rate":"0/s"},{"time":"1s","rate":"100/s"}]}
            }}]""",
            )
        assertThat(result.diagnostics).isEmpty()
        val profiles =
            result.experiment!!.variants.map {
                it.points
                    .single()
                    .graph.client.load
            }
        assertThat(profiles.map { it.rateAt(500.0) }).containsExactly(0.02, 0.05)
        assertThat(profiles.map { it.average(1_000.0) }).containsExactly(0.02, 0.05)
    }

    @Test
    fun `handler lint uses the maximum profile intensity rather than its mean`() {
        val result = compile("""{"points":[{"time":"0s","rate":"0/s"},{"time":"1s","rate":"20000/s"}]}""")

        val warning = ModelLinter().lint(result.experiment!!).single { it.code == "LINT_HANDLERS_LITTLE" }
        assertThat(warning.args).containsEntry("ratePerSecond", JsonPrimitive(20_000.0))
        assertThat(warning.message).contains("profile maximum", "conservative")
    }
}
