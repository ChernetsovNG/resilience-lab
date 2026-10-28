package resiliencelab.cli

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.Test

class CliTest {
    @TempDir
    lateinit var workspace: Path

    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val model = "retry-storm/retry-storm.model.json"
    private var runs = 0

    @BeforeEach
    fun copyExample() {
        val source = Path.of("examples")
        Files.walk(source.resolve("retry-storm")).use { paths ->
            paths.filter { Files.isRegularFile(it) }.forEach { file ->
                val destination = workspace.resolve(source.relativize(file).toString())
                Files.createDirectories(destination.parent)
                Files.copy(file, destination)
            }
        }
    }

    @Test
    fun `usage errors return 2 without output on stdout`() {
        listOf(
            emptyList(),
            listOf("unknown", experiment),
            listOf("validate"),
            listOf("run"),
            listOf("run", experiment, "extra"),
            listOf("run", "--workers", "0", experiment),
            listOf("run", "--workers", "many", experiment),
            listOf("validate", "--workers", "2", experiment),
            listOf("sweep", "sweep.json"),
        ).forEach { args ->
            val result = execute(args)

            assertThat(result.exitCode).describedAs(args.toString()).isEqualTo(2)
            assertThat(result.stdout).describedAs(args.toString()).isEmpty()
            assertThat(result.stderr).describedAs(args.toString()).contains("Usage:")
        }
    }

    @Test
    fun `validate accepts the example`() {
        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isZero()
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Valid experiment: $experiment", "WARNING", "LINT_TIMEOUT_BUDGET", "LINT_DEADLINE_BUDGET")
        assertThat(result.stderr).contains("baseline · $model#/connections/1/params/timeout").doesNotContain("variants:", "no-retries")
    }

    @Test
    fun `validate accepts an absolute path inside the workspace`() {
        assertThat(execute(listOf("validate", workspace.resolve(experiment).toString())).exitCode).isZero()
    }

    @Test
    fun `validate reports diagnostics with document and pointer`() {
        breakModel()

        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("$model#/blocks/dependency/params/handlers: PARAM_MISSING: ")
        assertThat(result.stderr).doesNotContain("\tat ")
    }

    @Test
    fun `malformed, missing and outside documents return 2`() {
        workspace.resolve(experiment).writeText("{ not JSON")
        assertThat(execute(listOf("validate", experiment)).stderr).contains("JSON_SYNTAX")

        val missing = execute(listOf("validate", "missing.experiment.json"))
        assertThat(missing.exitCode).isEqualTo(2)
        assertThat(missing.stderr).contains("DOCUMENT_MISSING")

        val outside = execute(listOf("validate", "../outside.experiment.json"))
        assertThat(outside.exitCode).isEqualTo(2)
        assertThat(outside.stderr).contains("Invalid input: experiment must be inside the workspace")
    }

    @Test
    fun `run writes the artifact and prints the run directory with a summary`() {
        val result = execute(listOf("run", experiment))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        assertThat(lines).hasSize(3)
        assertThat(lines[0]).isEqualTo(".results/retry-storm/run-1")
        assertThat(lines[1]).startsWith("baseline: success ").contains("p95 ", "p99 ")
        assertThat(lines[2]).startsWith("no-retries: success ")
        assertThat(workspace.resolve(".results/retry-storm/run-1/manifest.json")).exists()
        assertThat(result.stderr).contains("Tasks 4/4")
    }

    @Test
    fun `worker count does not change the result`() {
        execute(listOf("run", experiment))
        val first = workspace.resolve(".results/retry-storm/run-1/summary.json").readText()

        val result = execute(listOf("run", "--workers", "1", experiment))

        assertThat(result.exitCode).isZero()
        assertThat(workspace.resolve(".results/retry-storm/run-2/summary.json").readText()).isEqualTo(first)
    }

    @Test
    fun `run reports an invalid experiment without writing results`() {
        breakModel()

        val result = execute(listOf("run", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("PARAM_MISSING")
        assertThat(workspace.resolve(".results")).doesNotExist()
    }

    @Test
    fun `execution failures return 1 with a sanitized message`() {
        val result = execute(listOf("run", experiment)) { _, _, _, _ -> throw IllegalStateException("boom\n\tat somewhere") }

        assertThat(result.exitCode).isEqualTo(1)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Execution failed: boom").doesNotContain("\tat ")
    }

    @Test
    fun `unreadable documents are diagnostics, not crashes`() {
        Files.write(workspace.resolve(model), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))

        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stderr).contains("DOCUMENT_UNREADABLE").doesNotContain("\tat ")
    }

    @Test
    fun `installed launcher prints only the run directory and summary on stdout`() {
        val result = launch(listOf("run", experiment))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        assertThat(lines).hasSize(3)
        assertThat(lines[0]).matches("""\.results/retry-storm/\d{8}-\d{6}-\d{3}-[0-9a-f]{4}""")
        assertThat(workspace.resolve(lines[0]).resolve("manifest.json")).exists()
    }

    @Test
    fun `installed launcher reports invalid input with code 2 and no stack trace`() {
        Files.write(workspace.resolve(model), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))

        val result = launch(listOf("validate", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("DOCUMENT_UNREADABLE").doesNotContain("\tat ")
    }

    /** Runs the launcher from `installDist` as a separate process in the workspace. */
    private fun launch(args: List<String>): CommandResult {
        val launcherDirectory = Path.of("apps", "cli", "build", "install", "cli", "bin").toAbsolutePath()
        val command =
            if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
                listOf("cmd.exe", "/c", launcherDirectory.resolve("cli.bat").toString())
            } else {
                listOf(launcherDirectory.resolve("cli").toString())
            }
        val errorFile = Files.createTempFile("cli-stderr", ".log")
        val process =
            ProcessBuilder(command + args)
                .directory(workspace.toFile())
                .redirectError(errorFile.toFile())
                .start()
        val stdout = process.inputStream.readBytes().decodeToString()
        val exitCode = process.waitFor()
        return CommandResult(exitCode, stdout, errorFile.readText())
    }

    private fun breakModel() {
        val file = workspace.resolve(model)
        file.writeText(file.readText().replace("\"handlers\": 2,", ""))
    }

    private fun execute(
        args: List<String>,
        run: ExperimentRun? = null,
    ): CommandResult {
        val stdout = StringBuilder()
        val stderr = StringBuilder()
        val exitCode =
            if (run == null) {
                runCommand(args, stdout, stderr, workspace, newRunId = { "run-${++runs}" })
            } else {
                runCommand(args, stdout, stderr, workspace, newRunId = { "run-${++runs}" }, execute = run)
            }
        return CommandResult(exitCode, stdout.toString(), stderr.toString())
    }

    private data class CommandResult(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
    )
}
