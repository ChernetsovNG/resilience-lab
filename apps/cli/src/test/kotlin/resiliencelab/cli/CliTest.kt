package resiliencelab.cli

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.experiment.ExperimentResult
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.ExperimentDocument
import resiliencelab.core.scenario.ExperimentVariant
import resiliencelab.core.scenario.LinkSpec
import resiliencelab.core.scenario.RetryKind
import resiliencelab.core.scenario.RetrySpec
import resiliencelab.core.scenario.Scenario
import resiliencelab.core.scenario.ScenarioCodec
import resiliencelab.core.scenario.ServiceSpec
import resiliencelab.core.scenario.SweepDocument
import resiliencelab.core.scenario.SweepParameter
import resiliencelab.core.scenario.SweepSpec
import resiliencelab.core.scenario.WorkloadSpec
import resiliencelab.core.simulation.ExperimentExecutionException
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.Test

class CliTest {
    @TempDir
    lateinit var tempDir: Path

    @Test
    fun `usage errors return 2 without result output`() {
        val invocations =
            listOf(
                emptyList(),
                listOf("unknown"),
                listOf("validate"),
                listOf("run", "one.json", "two.json"),
                listOf("sweep"),
            )

        invocations.forEach { args ->
            val result = execute(args)

            assertThat(result.exitCode).describedAs(args.toString()).isEqualTo(2)
            assertThat(result.stdout).describedAs(args.toString()).isEmpty()
            assertThat(result.stderr).describedAs(args.toString()).contains("Usage:")
        }
    }

    @Test
    fun `validate accepts a valid experiment only on stderr`() {
        val path = writeExperiment(experimentDocument())

        val result = execute(listOf("validate", path.toString()))

        assertThat(result.exitCode).isZero()
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Valid experiment")
    }

    @Test
    fun `validate reports semantic validation errors as input errors`() {
        val path = writeExperiment(experimentDocument(replications = 0))

        val result = execute(listOf("validate", path.toString()))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("execution.replications")
        assertThat(result.stderr).doesNotContain("\n\tat ")
    }

    @Test
    fun `malformed JSON returns 2 without a stack trace`() {
        val path = tempDir.resolve("malformed.json").writeJson("{ not JSON")

        val result = execute(listOf("run", path.toString()))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Invalid input")
        assertThat(result.stderr).doesNotContain("\n\tat ")
    }

    @Test
    fun `unsupported schema returns 2 before execution`() {
        val path = writeExperiment(experimentDocument())
        path.writeJson(path.readText().replaceFirst("\"schemaVersion\": 1", "\"schemaVersion\": 2"))

        val result = execute(listOf("run", path.toString()))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("schemaVersion")
    }

    @Test
    fun `missing input file returns 2 without result output`() {
        val result = execute(listOf("validate", tempDir.resolve("missing.json").toString()))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Invalid input")
    }

    @Test
    fun `run executes retry storm example and returns a complete result JSON round trip`() {
        val result = execute(listOf("run", "examples/retry-storm.json"))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        assertThat(result.stderr).isEmpty()
        val decoded = Json.decodeFromString(ExperimentResult.serializer(), result.stdout)
        assertThat(decoded.schemaVersion).isEqualTo(1)
        assertThat(decoded.applicationVersion).isEqualTo("0.1.0")
        assertThat(decoded.kslVersion).isEqualTo("R1.8.1")
        assertThat(decoded.variants.map { it.id }).containsExactly("baseline", "candidate")
        decoded.variants.forEach { variant ->
            assertThat(variant.replications).hasSize(2)
            assertThat(
                variant.replications
                    .first()
                    .services.keys,
            ).containsExactlyInAnyOrder("gateway", "middle", "dependency")
        }
        val encoded = Json.encodeToString(ExperimentResult.serializer(), decoded)
        assertThat(Json.decodeFromString(ExperimentResult.serializer(), encoded)).isEqualTo(decoded)
    }

    @Test
    fun `process run emits only result JSON on stdout`() {
        val errorFile = tempDir.resolve("process-stderr.log")
        val repositoryRoot = Path.of("").toAbsolutePath().normalize()
        val launcherDirectory = Path.of("apps", "cli", "build", "install", "cli", "bin")
        val command =
            if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
                listOf("cmd.exe", "/c", launcherDirectory.resolve("cli.bat").toString())
            } else {
                listOf(launcherDirectory.resolve("cli").toString())
            }
        val process =
            ProcessBuilder(command + listOf("run", "examples/retry-storm.json"))
                .directory(repositoryRoot.toFile())
                .redirectError(errorFile.toFile())
                .start()

        val stdout = process.inputStream.readBytes().decodeToString()
        val exitCode = process.waitFor()

        assertThat(exitCode).describedAs(errorFile.readText()).isZero()
        val decoded = Json.decodeFromString(ExperimentResult.serializer(), stdout)
        assertThat(decoded.variants.map { it.id }).containsExactly("baseline", "candidate")
    }

    @Test
    fun `sweep executes both timeout points and preserves metadata`() {
        val path =
            tempDir
                .resolve("sweep.json")
                .writeJson(ScenarioCodec.encodeSweep(sweepDocument(values = listOf(25.0, 50.0))))

        val result = execute(listOf("sweep", path.toString()))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        assertThat(result.stderr).isEmpty()
        val decoded = Json.decodeFromString(ExperimentResult.serializer(), result.stdout)
        assertThat(decoded.applicationVersion).isEqualTo("0.1.0")
        assertThat(decoded.kslVersion).isEqualTo("R1.8.1")
        assertThat(decoded.variants.map { it.id }).containsExactly("sweep-0", "sweep-1")
        assertThat(decoded.variants.map { it.label }).containsExactly("sweep-0", "sweep-1")
        assertThat(decoded.variants.map { it.sweepParameter })
            .containsExactly(SweepParameter.LINK_TIMEOUT, SweepParameter.LINK_TIMEOUT)
        assertThat(decoded.variants.map { it.sweepValue }).containsExactly(25.0, 50.0)
        assertThat(decoded.variants.map { it.replications.size }).containsExactly(1, 1)
    }

    @Test
    fun `sweep expansion validation errors return 2`() {
        val path =
            tempDir
                .resolve("invalid-sweep.json")
                .writeJson(ScenarioCodec.encodeSweep(sweepDocument(values = listOf(0.0))))

        val result = execute(listOf("sweep", path.toString()))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("variants[0].scenario.links[0].timeoutMs")
    }

    @Test
    fun `execution failures return 1 and sanitize diagnostics`() {
        val path = writeExperiment(experimentDocument())

        val result =
            execute(listOf("run", path.toString())) {
                throw ExperimentExecutionException("synthetic execution failure")
            }

        assertThat(result.exitCode).isEqualTo(1)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Execution failed: synthetic execution failure")
        assertThat(result.stderr).doesNotContain("\n\tat ")
    }

    private fun execute(
        args: List<String>,
        runner: (ExperimentDocument) -> ExperimentResult = resiliencelab.core.experiment.ExperimentRunner::run,
    ): CommandResult {
        val stdout = StringBuilder()
        val stderr = StringBuilder()
        val exitCode = runCommand(args, stdout, stderr, runner)
        return CommandResult(exitCode, stdout.toString(), stderr.toString())
    }

    private fun writeExperiment(document: ExperimentDocument): Path =
        tempDir.resolve("experiment.json").writeJson(ScenarioCodec.encodeExperiment(document))

    private fun Path.writeJson(text: String): Path {
        java.nio.file.Files
            .writeString(this, text)
        return this
    }

    private fun experimentDocument(replications: Int = 1): ExperimentDocument =
        ExperimentDocument(
            schemaVersion = 1,
            execution = execution(replications),
            variants =
                listOf(
                    ExperimentVariant(
                        id = "baseline",
                        label = "Baseline",
                        scenario = simpleScenario(),
                        sweepParameter = null,
                        sweepValue = null,
                    ),
                ),
        )

    private fun sweepDocument(values: List<Double>): SweepDocument =
        SweepDocument(
            schemaVersion = 1,
            execution = execution(replications = 1),
            baseScenario = simpleScenario(),
            sweep =
                SweepSpec(
                    parameter = SweepParameter.LINK_TIMEOUT,
                    serviceId = null,
                    linkId = "entry-to-backend",
                    values = values,
                ),
        )

    private fun execution(replications: Int): Execution =
        Execution(
            replications = replications,
            warmupMs = 0.0,
            measurementMs = 20.0,
            seed = 42L,
            maxRealTimeSeconds = 5L,
        )

    private fun simpleScenario(): Scenario =
        Scenario(
            entry = "entry",
            services =
                listOf(
                    ServiceSpec(
                        id = "entry",
                        handlers = 1,
                        queueCapacity = 2,
                        processing = fixed(0.0),
                        failureRate = 0.0,
                    ),
                    ServiceSpec(
                        id = "backend",
                        handlers = 1,
                        queueCapacity = 2,
                        processing = fixed(0.0),
                        failureRate = 0.0,
                    ),
                ),
            links =
                listOf(
                    LinkSpec(
                        id = "entry-to-backend",
                        from = "entry",
                        to = "backend",
                        network = fixed(0.0),
                        timeoutMs = 50.0,
                        maxAttempts = 1,
                        retry =
                            RetrySpec(
                                kind = RetryKind.NONE,
                                baseBackoffMs = 0.0,
                                maxBackoffMs = 0.0,
                            ),
                    ),
                ),
            workload =
                WorkloadSpec(
                    arrivalRate = 0.1,
                    requestDeadlineMs = 100.0,
                ),
            degradation = null,
        )

    private fun fixed(meanMs: Double): DurationDistribution =
        DurationDistribution(
            kind = DistributionKind.FIXED,
            meanMs = meanMs,
            stdDevMs = null,
        )

    private data class CommandResult(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
    )
}
