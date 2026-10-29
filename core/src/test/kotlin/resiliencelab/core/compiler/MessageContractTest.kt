package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class MessageContractTest {
    private val sourceRoot =
        Path.of(System.getProperty("resilience-lab.project-root"), "core/src/main/kotlin/resiliencelab/core")
    private val entry =
        Regex(
            """^\s*([A-Z][A-Z0-9_]*)\(\s*("(?:\\.|[^"\\])*"),\s*(null|"(?:\\.|[^"\\])*"),\s*("(?:\\.|[^"\\])*"),?\s*\)""",
            RegexOption.MULTILINE,
        )
    private val reference = Regex("""\bCoreMessage\.([A-Z][A-Z0-9_]*)\b""")
    private val parameter = Regex("""\{(\w+)}""")
    private val literalEmitter =
        Regex(
            """\b(?:Diagnostic|EstimateWarning|\w+\.error|(?:\w+\.)?fail|report|warning|resumeFailure)(?:<[^>]+>)?\(\s*(?:code\s*=\s*)?"(?:\\.|[^"\\])*"""",
        )

    private data class Contract(
        val code: String,
        val reason: String?,
        val parameters: Set<String>,
    )

    @Test
    fun `every core emitter uses a registered message contract and every contract is used`() {
        val sources =
            Files.walk(sourceRoot).use { paths ->
                paths
                    .filter { it.fileName.toString().endsWith(".kt") }
                    .toList()
                    .associate { sourceRoot.relativize(it).toString() to Files.readString(it) }
            }
        val registry = sources.getValue("compiler/CoreMessage.kt")
        val contracts =
            entry.findAll(registry).associate { match ->
                val template = Json.decodeFromString<String>(match.groupValues[4])
                match.groupValues[1] to
                    Contract(
                        Json.decodeFromString(match.groupValues[2]),
                        Json.decodeFromString(match.groupValues[3]),
                        parameter.findAll(template).map { it.groupValues[1] }.toSet(),
                    )
            }
        val compiledContracts =
            CoreMessage.entries.associate { message ->
                message.name to
                    Contract(message.code, message.reason, parameter.findAll(message.template).map { it.groupValues[1] }.toSet())
            }
        assertThat(contracts).isNotEmpty().containsExactlyInAnyOrderEntriesOf(compiledContracts)
        assertThat(contracts.values.map { it.code to it.reason }.distinct())
            .describedAs("A message code and reason must select one argument contract")
            .hasSize(contracts.size)

        val emitters = sources.filterKeys { it != "compiler/CoreMessage.kt" }
        val used = emitters.values.flatMap { source -> reference.findAll(source).map { it.groupValues[1] }.toList() }.toSet()
        assertThat(used - contracts.keys).describedAs("Unregistered CoreMessage references").isEmpty()
        assertThat(contracts.keys - used).describedAs("Message contracts without a core emitter").isEmpty()
        val bypasses =
            emitters.flatMap { (path, source) ->
                literalEmitter
                    .findAll(source)
                    .map { match ->
                        "$path:${source.take(match.range.first).count { it == '\n' } + 1}: ${match.value}"
                    }.toList()
            }
        assertThat(bypasses).describedAs("Core messages must pass CoreMessage, retaining raw-code compatibility only in adapters").isEmpty()
    }

    @Test
    fun `source guard recognizes raw literal codes at every message entry point`() {
        listOf(
            "Diagnostic(\"NEW_CODE\", Severity.ERROR, text)",
            "Diagnostic(\ncode = \"NEW_CODE\", severity = Severity.ERROR, message = text)",
            "sink.error(\"NEW_CODE\", text, document)",
            "reader.fail<Unit>(\"NEW_CODE\", name, text)",
            "report(\"NEW_CODE\", text, name)",
            "warning(\"NEW_CODE\", text, origin, path, suffix)",
            "resumeFailure(\"NEW_CODE\", text, document)",
            "EstimateWarning(\"NEW_CODE\", text)",
        ).forEach { source ->
            assertThat(literalEmitter.containsMatchIn(source)).describedAs(source).isTrue()
        }
    }
}
