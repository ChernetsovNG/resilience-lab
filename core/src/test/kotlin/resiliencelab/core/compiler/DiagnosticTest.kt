package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class DiagnosticTest {
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
