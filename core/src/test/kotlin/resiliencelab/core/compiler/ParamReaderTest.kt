package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.Stage1Catalog
import kotlin.test.Test

class ParamReaderTest {
    private val serviceParams = Stage1Catalog.catalog.type("service")!!.params
    private val callParams = Stage1Catalog.catalog.type("call")!!.params

    private fun reader(
        json: String,
        diagnostics: MutableList<Diagnostic>,
        params: List<ParamDescriptor> = serviceParams,
    ) = ParamReader(
        Json.parseToJsonElement(json).jsonObject,
        params,
        "m.model.json",
        "/blocks/svc/params",
        "svc",
        diagnostics,
    )

    @Test
    fun `reads typed values and applies defaults`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader = reader("""{"handlers": 4, "processing": {"kind": "fixed", "mean": "2ms"}}""", diagnostics)

        assertThat(reader.int("handlers")).isEqualTo(4)
        assertThat(reader.int("queue")).isEqualTo(0)
        assertThat(reader.quantity("failureRate")).isEqualTo(0.0)
        val processing = reader.obj("processing")!!
        assertThat(processing.choice("kind")).isEqualTo("fixed")
        assertThat(processing.quantity("mean")).isEqualTo(2.0)
        assertThat(processing.has("stdDev")).isFalse()
        assertThat(processing.quantity("stdDev")).isNull()
        assertThat(diagnostics).isEmpty()
    }

    @Test
    fun `reports unknown, missing, mistyped and out-of-range parameters with pointers`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader = reader("""{"handlers": "4", "queue": -1, "failureRate": "150%", "extra": 1}""", diagnostics)

        assertThat(reader.int("handlers")).isNull()
        assertThat(reader.int("queue")).isNull()
        assertThat(reader.quantity("failureRate")).isNull()
        assertThat(reader.obj("processing")).isNull()

        assertThat(diagnostics.map { it.code to it.pointer }).containsExactly(
            "PARAM_UNKNOWN" to "/blocks/svc/params/extra",
            "PARAM_TYPE" to "/blocks/svc/params/handlers",
            "PARAM_RANGE" to "/blocks/svc/params/queue",
            "PARAM_RANGE" to "/blocks/svc/params/failureRate",
            "PARAM_MISSING" to "/blocks/svc/params/processing",
        )
        assertThat(diagnostics).allMatch { it.path == "svc" && it.severity == Severity.ERROR }
    }

    @Test
    fun `reads numbers, choices and nested defaults`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader = reader("""{"timeout": "80ms", "backoff": {"kind": "slow"}}""", diagnostics, callParams)

        assertThat(reader.obj("network")!!.quantity("mean")).isEqualTo(0.0)
        val backoff = reader.obj("backoff")!!
        assertThat(backoff.choice("kind")).isNull()
        assertThat(backoff.number("multiplier")).isEqualTo(2.0)
        assertThat(reader.quantity("timeout")).isEqualTo(80.0)
        assertThat(diagnostics.single().code).isEqualTo("PARAM_TYPE")
        assertThat(diagnostics.single().pointer).isEqualTo("/blocks/svc/params/backoff/kind")
    }

    @Test
    fun `rejects quantities without a unit and non-object values`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader = reader("""{"timeout": 80, "network": "fast", "attempts": 0}""", diagnostics, callParams)

        assertThat(reader.quantity("timeout")).isNull()
        assertThat(reader.obj("network")).isNull()
        assertThat(reader.int("attempts")).isNull()
        assertThat(diagnostics.map { it.code }).containsExactly("QUANTITY_INVALID", "PARAM_TYPE", "PARAM_RANGE")
    }

    @Test
    fun `reports overridden values at their place in the experiment`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val overrides =
            OverrideOrigins(
                "e.experiment.json",
                mapOf("attempts" to "/variants/1/overrides/c.attempts", "backoff" to "/variants/1/overrides/c.backoff"),
            )
        val params = Json.parseToJsonElement("""{"timeout": "x", "attempts": 0, "backoff": {"kind": "slow"}}""").jsonObject
        val reader = ParamReader(params, callParams, "m.model.json", "/connections/1/params", "c", diagnostics, overrides)

        reader.quantity("timeout")
        reader.int("attempts")
        reader.obj("backoff")!!.choice("kind")

        assertThat(diagnostics.map { it.document to it.pointer }).containsExactly(
            "m.model.json" to "/connections/1/params/timeout",
            "e.experiment.json" to "/variants/1/overrides/c.attempts",
            "e.experiment.json" to "/variants/1/overrides/c.backoff",
        )
    }

    @Test
    fun `reports invalid child at the child override when parent and child are overridden`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val overrides =
            OverrideOrigins(
                "e.experiment.json",
                mapOf(
                    "backoff" to "/variants/1/overrides/c.backoff",
                    "backoff.kind" to "/variants/1/overrides/c.backoff.kind",
                ),
            )
        val params = Json.parseToJsonElement("""{"backoff": {"kind": "slow"}}""").jsonObject
        val reader = ParamReader(params, callParams, "m.model.json", "/connections/1/params", "c", diagnostics, overrides)

        reader.obj("backoff")!!.choice("kind")

        assertThat(diagnostics.single().document).isEqualTo("e.experiment.json")
        assertThat(diagnostics.single().pointer).isEqualTo("/variants/1/overrides/c.backoff.kind")
    }
}
