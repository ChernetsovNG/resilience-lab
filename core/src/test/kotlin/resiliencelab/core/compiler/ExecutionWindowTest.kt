package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class ExecutionWindowTest {
    private val root = Path.of(System.getProperty("resilience-lab.project-root"), "examples", "retry-storm")
    private val model =
        (
            DocumentCodec.decodeModel(
                Files.readString(root.resolve("retry-storm.model.json")),
                "model",
            ) as DecodeResult.Ok
        ).value
    private val experiment =
        (
            DocumentCodec.decodeExperiment(
                Files.readString(root.resolve("retry-storm.experiment.json")),
                "experiment",
            ) as DecodeResult.Ok
        ).value

    @Test
    fun `window defaults to measurement divided by one hundred and accepts explicit durations`() {
        val default = compile(null).experiment!!.run
        assertThat(default.windowMs).isEqualTo(default.measurementMs / 100)
        assertThat(compile("0.25s").experiment!!.run.windowMs).isEqualTo(250.0)
    }

    @Test
    fun `window rejects nonpositive wrong-unit and unaddressable grids with a field diagnostic`() {
        listOf("0ms", "-1ms", "2rps", "1e-20ms").forEach { value ->
            val result = compile(value)
            assertThat(result.experiment).describedAs(value).isNull()
            assertThat(result.diagnostics).anyMatch { it.pointer == "/execution/window" }
        }
    }

    private fun compile(window: String?) =
        ModelCompiler().compile(
            model,
            "model",
            experiment.copy(execution = experiment.execution.copy(window = window)),
            "experiment",
        )
}
