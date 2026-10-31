package resiliencelab.server.lab

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.name
import kotlin.io.path.readText

/** The message registry follows actual emitters, so new API/job errors enter translation coverage. */
class ServerMessageContractTest {
    private val sources =
        Files.walk(Path.of("src/main/kotlin")).use { files ->
            files.filter { it.name.endsWith(".kt") }.toList().associateWith { it.readText() }
        }

    @Test
    fun `API problems are emitted through the structured message factory`() {
        sources
            .filterKeys { it.name !in setOf("ApiTypes.kt", "ServerMessage.kt") }
            .forEach { (path, source) ->
                assertThat(Regex("\\bApiProblem\\s*\\(").findAll(source).toList())
                    .describedAs("$path must use ServerMessage to keep errors in translation coverage")
                    .isEmpty()
            }
    }

    @Test
    fun `every emitted job error has a registered code and structured arguments`() {
        sources.forEach { (path, source) ->
            val errors = Regex("\\berror\\s*=").findAll(source).count()
            val codes =
                Regex(
                    "\\berrorCode\\s*=\\s*(ServerMessage\\.[A-Z_]+|diagnostic)\\.code",
                ).findAll(source).map { it.groupValues[1] }.toList()
            val arguments =
                Regex(
                    "\\berrorArgs\\s*=\\s*(ServerMessage\\.[A-Z_]+|diagnostic)\\.args(?:\\(|,)",
                ).findAll(source).map { it.groupValues[1] }.toList()
            assertThat(codes).describedAs("$path: every legacy error needs a stable code").hasSize(errors)
            assertThat(arguments).describedAs("$path: codes and arguments must use the same message definitions").isEqualTo(codes)
        }
    }

    @Test
    fun `every registered message is used by an emitter and has a unique translation key`() {
        val references =
            sources
                .filterKeys { it.name != "ServerMessage.kt" }
                .values
                .flatMap { source -> Regex("ServerMessage\\.([A-Z_]+)").findAll(source).map { it.groupValues[1] }.toList() }
                .toSet()
        assertThat(references).containsExactlyInAnyOrderElementsOf(ServerMessage.entries.map { it.name })
        val keys = ServerMessage.entries.map { it.code to it.reason }
        assertThat(keys).doesNotHaveDuplicates()
    }
}
