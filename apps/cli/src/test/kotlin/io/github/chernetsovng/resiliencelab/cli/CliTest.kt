package io.github.chernetsovng.resiliencelab.cli

import io.github.chernetsovng.resiliencelab.core.experiment.ExperimentResult
import io.github.chernetsovng.resiliencelab.core.scenario.DistributionKind
import io.github.chernetsovng.resiliencelab.core.scenario.DurationDistribution
import io.github.chernetsovng.resiliencelab.core.scenario.Execution
import io.github.chernetsovng.resiliencelab.core.scenario.ExperimentDocument
import io.github.chernetsovng.resiliencelab.core.scenario.ExperimentVariant
import io.github.chernetsovng.resiliencelab.core.scenario.LinkSpec
import io.github.chernetsovng.resiliencelab.core.scenario.RetryKind
import io.github.chernetsovng.resiliencelab.core.scenario.RetrySpec
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import io.github.chernetsovng.resiliencelab.core.scenario.ScenarioCodec
import io.github.chernetsovng.resiliencelab.core.scenario.ServiceSpec
import io.github.chernetsovng.resiliencelab.core.scenario.SweepDocument
import io.github.chernetsovng.resiliencelab.core.scenario.SweepParameter
import io.github.chernetsovng.resiliencelab.core.scenario.SweepSpec
import io.github.chernetsovng.resiliencelab.core.scenario.WorkloadSpec
import io.github.chernetsovng.resiliencelab.core.simulation.ExperimentExecutionException
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CliTest {
    @TempDir
    lateinit var tempDir: Path

    @Test
    fun `usage errors return 2 without result output`() {
        val invocations = listOf(
            emptyList(),
            listOf("unknown"),
            listOf("validate"),
            listOf("run", "one.json", "two.json"),
            listOf("sweep"),
        )

        invocations.forEach { args ->
            val result = execute(args)

            assertEquals(2, result.exitCode, args.toString())
            assertEquals("", result.stdout, args.toString())
            assertTrue(result.stderr.contains("Usage:"), args.toString())
        }
    }

    @Test
    fun `validate accepts a valid experiment only on stderr`() {
        val path = writeExperiment(experimentDocument())

        val result = execute(listOf("validate", path.toString()))

        assertEquals(0, result.exitCode)
        assertEquals("", result.stdout)
        assertTrue(result.stderr.contains("Valid experiment"))
    }

    @Test
    fun `validate reports semantic validation errors as input errors`() {
        val path = writeExperiment(experimentDocument(replications = 0))

        val result = execute(listOf("validate", path.toString()))

        assertEquals(2, result.exitCode)
        assertEquals("", result.stdout)
        assertTrue(result.stderr.contains("execution.replications"))
        assertFalse(result.stderr.contains("\n\tat "))
    }

    @Test
    fun `malformed JSON returns 2 without a stack trace`() {
        val path = tempDir.resolve("malformed.json").writeJson("{ not JSON")

        val result = execute(listOf("run", path.toString()))

        assertEquals(2, result.exitCode)
        assertEquals("", result.stdout)
        assertTrue(result.stderr.contains("Invalid input"))
        assertFalse(result.stderr.contains("\n\tat "))
    }

    @Test
    fun `unsupported schema returns 2 before execution`() {
        val path = writeExperiment(experimentDocument())
        path.writeJson(path.readText().replaceFirst("\"schemaVersion\": 1", "\"schemaVersion\": 2"))

        val result = execute(listOf("run", path.toString()))

        assertEquals(2, result.exitCode)
        assertEquals("", result.stdout)
        assertTrue(result.stderr.contains("schemaVersion"))
    }

    @Test
    fun `missing input file returns 2 without result output`() {
        val result = execute(listOf("validate", tempDir.resolve("missing.json").toString()))

        assertEquals(2, result.exitCode)
        assertEquals("", result.stdout)
        assertTrue(result.stderr.contains("Invalid input"))
    }

    @Test
    fun `run executes retry storm example and returns a complete result JSON round trip`() {
        val result = execute(listOf("run", "examples/retry-storm.json"))

        assertEquals(0, result.exitCode, result.stderr)
        assertEquals("", result.stderr)
        val decoded = Json.decodeFromString(ExperimentResult.serializer(), result.stdout)
        assertEquals(1, decoded.schemaVersion)
        assertEquals("0.1.0", decoded.applicationVersion)
        assertEquals("R1.8.1", decoded.kslVersion)
        assertEquals(listOf("baseline", "candidate"), decoded.variants.map { it.id })
        decoded.variants.forEach { variant ->
            assertEquals(2, variant.replications.size)
            assertEquals(
                setOf("gateway", "middle", "dependency"),
                variant.replications.first().services.keys,
            )
        }
        val encoded = Json.encodeToString(ExperimentResult.serializer(), decoded)
        assertEquals(decoded, Json.decodeFromString(ExperimentResult.serializer(), encoded))
    }

    @Test
    fun `process run emits only result JSON on stdout`() {
        val errorFile = tempDir.resolve("process-stderr.log")
        val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
        val process = ProcessBuilder(
            java,
            "-cp",
            System.getProperty("java.class.path"),
            "io.github.chernetsovng.resiliencelab.cli.MainKt",
            "run",
            "examples/retry-storm.json",
        ).redirectError(errorFile.toFile()).start()

        val stdout = process.inputStream.readBytes().decodeToString()
        val exitCode = process.waitFor()

        assertEquals(0, exitCode, errorFile.readText())
        val decoded = Json.decodeFromString(ExperimentResult.serializer(), stdout)
        assertEquals(listOf("baseline", "candidate"), decoded.variants.map { it.id })
    }

    @Test
    fun `sweep executes both timeout points and preserves metadata`() {
        val path = tempDir.resolve("sweep.json")
            .writeJson(ScenarioCodec.encodeSweep(sweepDocument(values = listOf(25.0, 50.0))))

        val result = execute(listOf("sweep", path.toString()))

        assertEquals(0, result.exitCode, result.stderr)
        assertEquals("", result.stderr)
        val decoded = Json.decodeFromString(ExperimentResult.serializer(), result.stdout)
        assertEquals("0.1.0", decoded.applicationVersion)
        assertEquals("R1.8.1", decoded.kslVersion)
        assertEquals(listOf("sweep-0", "sweep-1"), decoded.variants.map { it.id })
        assertEquals(listOf("sweep-0", "sweep-1"), decoded.variants.map { it.label })
        assertEquals(List(2) { SweepParameter.LINK_TIMEOUT }, decoded.variants.map { it.sweepParameter })
        assertEquals(listOf(25.0, 50.0), decoded.variants.map { it.sweepValue })
        assertEquals(List(2) { 1 }, decoded.variants.map { it.replications.size })
    }

    @Test
    fun `sweep expansion validation errors return 2`() {
        val path = tempDir.resolve("invalid-sweep.json")
            .writeJson(ScenarioCodec.encodeSweep(sweepDocument(values = listOf(0.0))))

        val result = execute(listOf("sweep", path.toString()))

        assertEquals(2, result.exitCode)
        assertEquals("", result.stdout)
        assertTrue(result.stderr.contains("variants[0].scenario.links[0].timeoutMs"))
    }

    @Test
    fun `execution failures return 1 and sanitize diagnostics`() {
        val path = writeExperiment(experimentDocument())

        val result = execute(listOf("run", path.toString())) {
            throw ExperimentExecutionException("synthetic execution failure")
        }

        assertEquals(1, result.exitCode)
        assertEquals("", result.stdout)
        assertTrue(result.stderr.contains("Execution failed: synthetic execution failure"))
        assertFalse(result.stderr.contains("\n\tat "))
    }

    private fun execute(
        args: List<String>,
        runner: (ExperimentDocument) -> ExperimentResult = io.github.chernetsovng.resiliencelab.core.experiment.ExperimentRunner::run,
    ): CommandResult {
        val stdout = StringBuilder()
        val stderr = StringBuilder()
        val exitCode = runCommand(args, stdout, stderr, runner)
        return CommandResult(exitCode, stdout.toString(), stderr.toString())
    }

    private fun writeExperiment(document: ExperimentDocument): Path =
        tempDir.resolve("experiment.json").writeJson(ScenarioCodec.encodeExperiment(document))

    private fun Path.writeJson(text: String): Path {
        java.nio.file.Files.writeString(this, text)
        return this
    }

    private fun experimentDocument(replications: Int = 1): ExperimentDocument = ExperimentDocument(
        schemaVersion = 1,
        execution = execution(replications),
        variants = listOf(
            ExperimentVariant(
                id = "baseline",
                label = "Baseline",
                scenario = simpleScenario(),
                sweepParameter = null,
                sweepValue = null,
            ),
        ),
    )

    private fun sweepDocument(values: List<Double>): SweepDocument = SweepDocument(
        schemaVersion = 1,
        execution = execution(replications = 1),
        baseScenario = simpleScenario(),
        sweep = SweepSpec(
            parameter = SweepParameter.LINK_TIMEOUT,
            serviceId = null,
            linkId = "entry-to-backend",
            values = values,
        ),
    )

    private fun execution(replications: Int): Execution = Execution(
        replications = replications,
        warmupMs = 0.0,
        measurementMs = 20.0,
        seed = 42L,
        maxRealTimeSeconds = 5L,
    )

    private fun simpleScenario(): Scenario = Scenario(
        entry = "entry",
        services = listOf(
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
        links = listOf(
            LinkSpec(
                id = "entry-to-backend",
                from = "entry",
                to = "backend",
                network = fixed(0.0),
                timeoutMs = 50.0,
                maxAttempts = 1,
                retry = RetrySpec(
                    kind = RetryKind.NONE,
                    baseBackoffMs = 0.0,
                    maxBackoffMs = 0.0,
                ),
            ),
        ),
        workload = WorkloadSpec(
            arrivalRate = 0.1,
            requestDeadlineMs = 100.0,
        ),
        degradation = null,
    )

    private fun fixed(meanMs: Double): DurationDistribution = DurationDistribution(
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
