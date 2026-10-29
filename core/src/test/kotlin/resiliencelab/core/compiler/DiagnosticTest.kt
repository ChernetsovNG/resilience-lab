package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.execution.EstimateWarning
import kotlin.test.Test

class DiagnosticTest {
    @Test
    fun `older diagnostics and estimate warnings decode without message arguments`() {
        val diagnostic = Json.decodeFromString<Diagnostic>("""{"code":"OLD","severity":"ERROR","message":"legacy"}""")
        val warning = Json.decodeFromString<EstimateWarning>("""{"code":"OLD","message":"legacy"}""")

        assertThat(diagnostic.args).isNull()
        assertThat(warning.args).isNull()
        assertThat(Json.encodeToJsonElement(diagnostic).jsonObject).doesNotContainKey("args")
        assertThat(Json.encodeToJsonElement(warning).jsonObject).doesNotContainKey("args")
    }

    @Test
    fun `collector retains string and numeric arguments through serialization`() {
        val sink = Diagnostics()
        sink.error("CODE", "legacy", "m.model.json", args = mapOf("parameter" to JsonPrimitive("queue"), "minimum" to JsonPrimitive(0)))

        val diagnostic = Json.decodeFromString<Diagnostic>(Json.encodeToJsonElement(sink.items.single()).toString())

        assertThat(diagnostic.message).isEqualTo("legacy")
        assertThat(diagnostic.args).containsExactlyInAnyOrderEntriesOf(
            mapOf(
                "parameter" to JsonPrimitive("queue"),
                "minimum" to JsonPrimitive(0),
            ),
        )
    }

    @Test
    fun `builds RFC 6901 pointers with escaping`() {
        assertThat(JsonPointer.of("blocks", "a/b", "params")).isEqualTo("/blocks/a~1b/params")
        assertThat(JsonPointer.of("variants", 1, "overrides", "x~y")).isEqualTo("/variants/1/overrides/x~0y")
        assertThat(JsonPointer.child("/blocks", "gateway")).isEqualTo("/blocks/gateway")
    }

    @Test
    fun `collects errors and counts them`() {
        val sink = Diagnostics()
        sink.error("CODE", "message", "a.model.json", "/blocks", "gateway")
        assertThat(sink.errorCount()).isEqualTo(1)
        assertThat(sink.items.single())
            .isEqualTo(Diagnostic("CODE", Severity.ERROR, "message", "a.model.json", "/blocks", "gateway"))
    }
}
