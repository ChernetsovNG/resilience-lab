package resiliencelab.core.document

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
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
                "retry-storm" to mapOf("LINT_TIMEOUT_BUDGET/baseline" to 1, "LINT_RETRY_OVERLOAD/baseline" to 1),
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
        val policies =
            mapOf(
                "checkout-policies/slow-replica" to mapOf("LINT_TIMEOUT_BUDGET/all" to 3),
                "checkout-policies/partner-burst" to
                    mapOf(
                        "LINT_TIMEOUT_BUDGET/all" to 3,
                        "LINT_HANDLERS_LITTLE/baseline" to 3,
                        "LINT_HANDLERS_LITTLE/rate-limit" to 3,
                    ),
                "checkout-policies/psp-outage" to
                    mapOf(
                        "LINT_TIMEOUT_BUDGET/all" to 3,
                        "LINT_TIMEOUT_BUDGET/retries" to 1,
                        "LINT_TIMEOUT_BUDGET/retry-budget" to 1,
                        "LINT_RETRY_NO_JITTER/retries" to 3,
                        "LINT_RETRY_NO_JITTER/retry-budget" to 3,
                    ),
            )
        (expected + policies).forEach { (example, warnings) ->
            val directory = Path.of("../examples", example.substringBefore('/'))
            val modelName = example.substringBefore('/')
            val experimentName = example.substringAfter('/')
            val modelPath = directory.resolve("$modelName.model.json")
            val experimentPath = directory.resolve("$experimentName.experiment.json")
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

            if (example.startsWith("checkout-policies/")) return@forEach
            val (parameter, capacity, waitMs, limitMs) =
                when (example) {
                    "retry-storm" -> listOf("gateway.queue", "80", "260", "250")
                    "checkout" -> listOf("payment-service.queue", "1000", "7000", "3000")
                    else -> listOf("orders-db.queue", "3000", "150", "100")
                }
            val oversized =
                experiment.copy(
                    variants =
                        listOf(
                            experiment.variants.first().let {
                                it.copy(
                                    overrides =
                                        it.overrides + (parameter to JsonPrimitive(capacity.toInt())),
                                )
                            },
                        ),
                )
            val recompiled = ModelCompiler().compile(model, modelPath.toString(), oversized, experimentPath.toString())
            assertThat(recompiled.diagnostics).describedAs(example).isEmpty()
            val queue = ModelLinter().lint(requireNotNull(recompiled.experiment)).single { it.code == "LINT_QUEUE_WAIT" }
            assertThat(queue.args).containsEntry("estimatedMs", JsonPrimitive(waitMs)).containsEntry("limitMs", JsonPrimitive(limitMs))
            assertThat(queue.pointer).isEqualTo("/variants/0/overrides/$parameter")
            assertThat(queue.variant).isEqualTo("baseline")
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
        assertThat(warning.args).containsEntry("estimatedMs", JsonPrimitive("845"))
        assertThat(warning.pointer).isEqualTo("/variants/0/overrides/payment-service-to-psp.timeout")
        assertThat(warning.document).isEqualTo(experimentPath)
        assertThat(warning.variant).isEqualTo("aligned-timeouts")
    }
}
