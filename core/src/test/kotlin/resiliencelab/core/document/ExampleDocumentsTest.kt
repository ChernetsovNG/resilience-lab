package resiliencelab.core.document

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.compiler.ModelLinter
import resiliencelab.core.compiler.Severity
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class ExampleDocumentsTest {
    @Test
    fun `example lint warnings match the documented variants`() {
        val expected =
            mapOf(
                "retry-storm" to mapOf("LINT_TIMEOUT_BUDGET/baseline" to 1),
                "checkout" to
                    mapOf(
                        "LINT_TIMEOUT_BUDGET/baseline" to 2,
                        "LINT_TIMEOUT_BUDGET/no-order-retries" to 1,
                        "LINT_TIMEOUT_BUDGET/bigger-payment-pool" to 2,
                        "LINT_RETRY_NO_JITTER/baseline" to 1,
                        "LINT_RETRY_NO_JITTER/aligned-timeouts" to 1,
                        "LINT_RETRY_NO_JITTER/bigger-payment-pool" to 1,
                    ),
                "checkout-replicas" to
                    mapOf(
                        "LINT_TIMEOUT_BUDGET/all" to 1,
                        "LINT_DEADLINE_BUDGET/baseline" to 1,
                        "LINT_DEADLINE_BUDGET/other-replica" to 1,
                        "LINT_DEADLINE_BUDGET/least-in-flight" to 1,
                        "LINT_DEADLINE_BUDGET/bigger-pool" to 1,
                        "LINT_DEADLINE_BUDGET/no-backoff" to 1,
                        "LINT_RETRY_NO_JITTER/baseline" to 1,
                        "LINT_RETRY_NO_JITTER/other-replica" to 1,
                        "LINT_RETRY_NO_JITTER/least-in-flight" to 1,
                        "LINT_RETRY_NO_JITTER/bigger-pool" to 1,
                        "LINT_RETRY_NO_JITTER/no-backoff" to 1,
                    ),
            )
        expected.forEach { (example, warnings) ->
            val directory = Path.of("../examples", example)
            val modelPath = directory.resolve("$example.model.json")
            val experimentPath = directory.resolve("$example.experiment.json")
            val model = (DocumentCodec.decodeModel(Files.readString(modelPath), modelPath.toString()) as DecodeResult.Ok).value
            val experiment =
                (DocumentCodec.decodeExperiment(Files.readString(experimentPath), experimentPath.toString()) as DecodeResult.Ok).value
            val compiled = ModelCompiler().compile(model, modelPath.toString(), experiment, experimentPath.toString())
            assertThat(compiled.diagnostics).describedAs(example).isEmpty()
            val diagnostics = ModelLinter().lint(requireNotNull(compiled.experiment))

            assertThat(diagnostics).allSatisfy { assertThat(it.severity).isEqualTo(Severity.WARNING) }
            assertThat(diagnostics.groupingBy { "${it.code}/${it.variant ?: "all"}" }.eachCount())
                .describedAs(example)
                .isEqualTo(warnings)
        }
    }

    @Test
    fun `example documents are in canonical form`() {
        Files.walk(Path.of("../examples")).use { paths ->
            val documents = paths.filter { it.fileName.toString().matches(Regex(".*\\.(model|layout|experiment)\\.json")) }.toList()
            assertThat(documents).isNotEmpty()
            documents.forEach { file ->
                val text = Files.readString(file)
                val canonical =
                    when {
                        file.toString().endsWith(".model.json") ->
                            DocumentCodec.encodeModel((DocumentCodec.decodeModel(text, file.toString()) as DecodeResult.Ok).value)
                        file.toString().endsWith(".layout.json") ->
                            DocumentCodec.encodeLayout((DocumentCodec.decodeLayout(text, file.toString()) as DecodeResult.Ok).value)
                        else ->
                            DocumentCodec.encodeExperiment((DocumentCodec.decodeExperiment(text, file.toString()) as DecodeResult.Ok).value)
                    }
                assertThat(canonical).describedAs(file.toString()).isEqualTo(text)
            }
        }
    }

    @Test
    fun `original checkout PSP timeout warns even with aligned downstream budgets`() {
        val directory = Path.of("../examples/checkout")
        val modelPath = directory.resolve("checkout.model.json").toString()
        val experimentPath = directory.resolve("checkout.experiment.json").toString()
        val model = (DocumentCodec.decodeModel(Files.readString(Path.of(modelPath)), modelPath) as DecodeResult.Ok).value
        val source = (DocumentCodec.decodeExperiment(Files.readString(Path.of(experimentPath)), experimentPath) as DecodeResult.Ok).value
        val aligned = source.variants.single { it.id == "aligned-timeouts" }
        val experiment =
            source.copy(
                variants =
                    listOf(
                        aligned.copy(overrides = aligned.overrides + ("payment-service-to-psp.timeout" to JsonPrimitive("500ms"))),
                    ),
            )
        val compiled = ModelCompiler().compile(model, modelPath, experiment, experimentPath)
        assertThat(compiled.diagnostics).isEmpty()

        val warning = ModelLinter().lint(requireNotNull(compiled.experiment)).single { it.code == "LINT_TIMEOUT_BELOW_LATENCY" }

        assertThat(warning.args).containsEntry("target", JsonPrimitive("psp")).containsEntry("timeoutMs", JsonPrimitive("500"))
        assertThat(
            warning.args
                ?.get("estimatedMs")
                ?.content
                ?.toDouble(),
        ).isCloseTo(845.2337429414625, offset(0.00001))
        assertThat(warning.pointer).isEqualTo("/variants/0/overrides/payment-service-to-psp.timeout")
        assertThat(warning.document).isEqualTo(experimentPath)
        assertThat(warning.variant).isEqualTo("aligned-timeouts")
    }
}
