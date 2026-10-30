package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import kotlin.test.Test

class LoadProfileCompilerTest {
    private fun compile(
        load: String,
        extra: String = "",
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
             "variants": [{"id": "baseline"}] $extra}
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
            """{"points":[{"time":"0s","rate":"1/s"}],"sinusoid":{"amplitude":"2/s","period":"1s"}}""" to
                "/blocks/client/params/load",
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
    fun `sinusoid amplitude is sweepable`() {
        val result =
            compile(
                """{"points":[{"time":"0s","rate":"20/s"}],"sinusoid":{"amplitude":"1/s","period":"1s"}}""",
                """, "grid":[{"path":"client.load.sinusoid.amplitude","values":["2/s","4/s"]}]""",
            )

        assertThat(result.diagnostics).isEmpty()
        assertThat(
            result.experiment!!
                .variants
                .single()
                .points
                .map { it.coordinates.values.single() },
        ).containsExactly(Json.parseToJsonElement("\"2/s\""), Json.parseToJsonElement("\"4/s\""))
    }

    @Test
    fun `negative sum caused by an amplitude grid value points to that value`() {
        val result =
            compile(
                """{"points":[{"time":"0s","rate":"20/s"}],"sinusoid":{"amplitude":"1/s","period":"1s"}}""",
                """, "grid":[{"path":"client.load.sinusoid.amplitude","values":["30/s"]}]""",
            )

        val diagnostic = result.diagnostics.single { it.code == "LOAD_NEGATIVE" }
        assertThat(diagnostic.document).isEqualTo("e.experiment.json")
        assertThat(diagnostic.pointer).isEqualTo("/grid/0/values/0")
    }

    @Test
    fun `handler lint uses the maximum profile intensity rather than its mean`() {
        val result = compile("""{"points":[{"time":"0s","rate":"0/s"},{"time":"1s","rate":"20000/s"}]}""")

        val warning = ModelLinter().lint(result.experiment!!).single { it.code == "LINT_HANDLERS_LITTLE" }
        assertThat(warning.args).containsEntry("ratePerSecond", JsonPrimitive(20_000.0))
        assertThat(warning.message).contains("profile maximum", "conservative")
    }
}
