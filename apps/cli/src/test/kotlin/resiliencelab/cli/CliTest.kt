package resiliencelab.cli

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Assumptions.assumeFalse
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.execution.ExperimentEstimate
import resiliencelab.core.experiment.AggregateEntries
import resiliencelab.core.experiment.MetricSummary
import resiliencelab.core.lab.Lab
import resiliencelab.core.results.ArtifactWriter
import resiliencelab.core.results.FirstNodeSaturation
import resiliencelab.core.results.SlotPoolLabel
import resiliencelab.core.workspace.FileWorkspace
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit.SECONDS
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.Test

class CliTest {
    @Test
    fun `prints recorded headroom instead of computing a service maximum`() {
        val stdout = StringBuilder()
        val status =
            runCommand(
                listOf("run", experiment),
                stdout,
                StringBuilder(),
                workspace,
                newRunId = { "headroom" },
                execute = { lab, path, id, _, _ ->
                    val result = lab.run(path, id)
                    val peak =
                        resiliencelab.core.results.SlotPoolPeak(
                            "to-db#2",
                            "pool",
                            0.91,
                            resiliencelab.core.results.SlotPoolLabel(
                                "RESULT_SLOT_POOL",
                                "connection pool order-service#2 → pgbouncer",
                                emptyMap(),
                            ),
                        )
                    result.copy(
                        summary =
                            result.summary.copy(
                                variants =
                                    result.summary.variants.map { variant ->
                                        variant.copy(
                                            points =
                                                variant.points.map { point ->
                                                    point.copy(
                                                        headroom = resiliencelab.core.results.CapacityHeadroom(peak),
                                                        saturation =
                                                            point.saturation.copy(
                                                                withoutSaturation = variant.replications,
                                                                firstNodes = emptyList(),
                                                            ),
                                                    )
                                                },
                                        )
                                    },
                            ),
                    )
                },
            )
        assertThat(status).isZero()
        assertThat(stdout.toString())
            .contains(
                "without saturation: 10 of 10 replications; capacity headroom (pooled over measurement): " +
                    "utilization 91.00% at connection pool order-service#2 → pgbouncer, mean queue n/a",
            ).doesNotContain("first saturation:")
    }

    @Test
    fun `prints every recorded first slot set and hides headroom when some replications saturate`() {
        val firstNodes =
            listOf(
                FirstNodeSaturation(
                    "db-proxy",
                    6,
                    12.5,
                    0.0,
                    25.0,
                    "clientConnections",
                    SlotPoolLabel("RESULT_SLOT_POOLER_CLIENT", "client connections db-proxy", emptyMap()),
                ),
                FirstNodeSaturation(
                    "db-proxy",
                    3,
                    100.0,
                    90.0,
                    120.0,
                    "serverConnections",
                    SlotPoolLabel("RESULT_SLOT_POOLER_SERVER", "server connections db-proxy", emptyMap()),
                ),
            )
        val result =
            execute(listOf("run", experiment)) { lab, path, id, _, _ ->
                val run = lab.run(path, id)
                val variant = run.summary.variants.first()
                val point = variant.points.first()
                val saturation = point.saturation.copy(firstNodes = firstNodes, withoutSaturation = 1)
                run.copy(
                    summary =
                        run.summary.copy(
                            variants = listOf(variant.copy(points = listOf(point.copy(saturation = saturation)))),
                        ),
                )
            }

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        assertThat(result.stdout)
            .contains(
                "first saturation: client connections db-proxy (db-proxy/clientConnections) in 6 of 10 replications, " +
                    "median start 12.5 ms, range 0.0–25.0 ms; " +
                    "first saturation: server connections db-proxy (db-proxy/serverConnections) in 3 of 10 replications, " +
                    "median start 100.0 ms, range 90.0–120.0 ms; without saturation: 1 of 10 replications\n",
            ).doesNotContain("capacity headroom")
    }

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
            listOf("estimate"),
            listOf("resume"),
            listOf("summary"),
            listOf("summary", "--replicas"),
            listOf("summary", "run-1", "extra"),
            listOf("run", "--replicas", "--replicas", experiment),
            listOf("validate", "--replicas", experiment),
            listOf("estimate", experiment, "extra"),
            listOf("resume", "run-1", "extra"),
            listOf("run", experiment, "extra"),
            listOf("run", "--workers", "0", experiment),
            listOf("run", "--workers", "many", experiment),
            listOf("validate", "--workers", "2", experiment),
            listOf("sweep", "sweep.json"),
            listOf("catalog", "extra"),
            listOf("schema"),
            listOf("schema", "unknown"),
            listOf("schema", "model", "extra"),
        ).forEach { args ->
            val result = execute(args)

            assertThat(result.exitCode).describedAs(args.toString()).isEqualTo(2)
            assertThat(result.stdout).describedAs(args.toString()).isEmpty()
            assertThat(result.stderr)
                .describedAs(args.toString())
                .contains("Usage:", "catalog", "schema <model|layout|experiment>")
        }
    }

    @Test
    fun `catalog prints the JSON returned by the API`() {
        val result = execute(listOf("catalog"))

        val expected = Json { encodeDefaults = true }.encodeToString(Catalog.serializer(), Stage1Catalog.catalog)
        assertThat(result.exitCode).isZero()
        assertThat(result.stdout).isEqualTo(expected + "\n")
        assertThat(result.stderr).isEmpty()
    }

    @Test
    fun `schema prints each committed schema byte for byte`() {
        listOf("model", "layout", "experiment").forEach { kind ->
            val result = execute(listOf("schema", kind))

            assertThat(result.exitCode).describedAs(kind).isZero()
            assertThat(result.stdout).describedAs(kind).isEqualTo(Path.of("schemas/$kind.schema.json").readText())
            assertThat(result.stderr).describedAs(kind).isEmpty()
        }
    }

    @Test
    fun `validate accepts the example`() {
        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isZero()
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Valid experiment: $experiment", "WARNING", "LINT_TIMEOUT_BUDGET")
        assertThat(result.stderr).contains("baseline · $model#/connections/1/params/timeout").doesNotContain("variants:", "no-retries")
        assertThat(result.stderr)
            .doesNotContain("LINT_FEW_REPLICATIONS", "LINT_DEADLINE_BUDGET")
            .contains("Timeout 80 ms", "estimated 189 ms")
    }

    @Test
    fun `validate accepts an absolute path inside the workspace`() {
        assertThat(execute(listOf("validate", workspace.resolve(experiment).toString())).exitCode).isZero()
    }

    @Test
    fun `validate warns about few replications without blocking run`() {
        val file = workspace.resolve(experiment)
        file.writeText(file.readText().replace(Regex("\"replications\": \\d+"), "\"replications\": 4"))

        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isZero()
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("$experiment#/execution/replications: WARNING: LINT_FEW_REPLICATIONS:")
        assertThat(Regex("LINT_FEW_REPLICATIONS").findAll(result.stderr).count()).isEqualTo(1)
        assertThat(execute(listOf("run", experiment)).exitCode).isZero()
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
        assertThat(lines[0]).isEqualTo(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-1")
        assertThat(lines[1]).startsWith("baseline/p0: entry total: success ").contains("p95 ", "p99 ")
        assertThat(lines[2]).startsWith("no-retries/p0: entry total: success ")
        assertThat(
            workspace.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-1/manifest.json"),
        ).exists()
        assertThat(result.stderr).contains("Tasks 20/20").doesNotContain("LINT_FEW_REPLICATIONS")
    }

    @Test
    fun `run and saved summary print sorted entry rows with the three leading failure reasons`() {
        fun metric(value: Double) = MetricSummary(1, value, null, null, null, value, value)

        val result =
            execute(listOf("run", experiment)) { lab, path, id, _, _ ->
                val run = lab.run(path, id)
                val variant = run.summary.variants.first()
                val point = variant.points.first()
                val base = point.aggregate.entries.total

                fun entry(
                    success: Double,
                    timeouts: Double,
                ) = base.copy(
                    successRate = metric(success),
                    p95LatencyMs = metric(12.0),
                    p99LatencyMs = metric(20.0),
                    failuresByReason =
                        linkedMapOf(
                            "unavailable" to metric(0.05),
                            "error" to metric(0.10),
                            "timeout" to metric(timeouts),
                            "queueFull" to metric(0.05),
                            "deadline" to metric(0.10),
                        ),
                )

                val entries =
                    AggregateEntries(
                        total = entry(0.4, 0.3),
                        clients = linkedMapOf("partner" to entry(0.5, 0.2), "mobile" to entry(0.3, 0.4)),
                        classes = linkedMapOf("write" to entry(0.2, 0.5), "read" to entry(0.6, 0.1)),
                    )
                val summary =
                    run.summary.copy(
                        variants =
                            listOf(
                                variant.copy(points = listOf(point.copy(aggregate = point.aggregate.copy(entries = entries)))),
                            ),
                    )
                val manifest = ArtifactWriter(FileWorkspace(workspace)).rewrite(run.runDirectory, run.manifest, summary)
                run.copy(summary = summary, manifest = manifest)
            }

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        assertThat(lines).hasSize(6)
        assertThat(lines[1]).startsWith(
            "baseline/p0: entry total: success 40.0%, p95 12.0 ms, p99 20.0 ms; " +
                "failure reasons timeout 30.0%, deadline 10.0%, error 10.0%; ",
        )
        assertThat(lines.drop(2)).containsExactly(
            "  entry client mobile: success 30.0%, p95 12.0 ms, p99 20.0 ms; " +
                "failure reasons timeout 40.0%, deadline 10.0%, error 10.0%",
            "  entry client partner: success 50.0%, p95 12.0 ms, p99 20.0 ms; " +
                "failure reasons timeout 20.0%, deadline 10.0%, error 10.0%",
            "  entry class read: success 60.0%, p95 12.0 ms, p99 20.0 ms; " +
                "failure reasons deadline 10.0%, error 10.0%, timeout 10.0%",
            "  entry class write: success 20.0%, p95 12.0 ms, p99 20.0 ms; " +
                "failure reasons timeout 50.0%, deadline 10.0%, error 10.0%",
        )
        assertThat(result.stdout).doesNotContain("queueFull", "unavailable")

        val saved = execute(listOf("summary", lines.first().substringAfterLast('/')))
        assertThat(saved.exitCode).describedAs(saved.stderr).isZero()
        assertThat(saved.stdout).isEqualTo(result.stdout)
        assertThat(saved.stderr).isEmpty()
    }

    @Test
    fun `retry storm preserves total metrics and saturation with and without replica expansion`() {
        val expected =
            "baseline/p0: entry total: success 61.5%, p95 251.9 ms, p99 252.0 ms; " +
                "first saturation: handlers dependency (dependency/handlers) in 10 of 10 replications, " +
                "median start 225.0 ms, range 210.0–290.0 ms; without saturation: 0 of 10 replications\n" +
                "no-retries/p0: entry total: success 51.4%, p95 184.0 ms, p99 219.0 ms; " +
                "first saturation: handlers dependency (dependency/handlers) in 10 of 10 replications, " +
                "median start 225.0 ms, range 210.0–290.0 ms; without saturation: 0 of 10 replications\n"
        listOf(listOf("run", experiment), listOf("run", "--replicas", experiment)).forEach { args ->
            val result = execute(args)
            assertThat(result.exitCode).describedAs(result.stderr).isZero()
            assertThat(result.stdout.substringAfter('\n').replace(Regex("; failure reasons [^;\\n]+"), "")).isEqualTo(expected)
            val saved =
                execute(
                    listOf(
                        "summary",
                        result.stdout
                            .lineSequence()
                            .first()
                            .substringAfterLast('/'),
                    ),
                )
            assertThat(saved.exitCode).describedAs(saved.stderr).isZero()
            assertThat(saved.stdout).isEqualTo(result.stdout)
        }
    }

    @Test
    fun `run prints services before groups with the worst replica and hides children`() {
        replicaModel()

        val result = execute(listOf("run", "replicas.experiment.json"))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        assertThat(result.stdout).contains("  service gateway:", "  group worker:")
        val lines = result.stdout.lines()
        val service = lines.single { it.startsWith("  service gateway:") }
        val group = lines.single { it.startsWith("  group worker:") }
        assertThat(lines.indexOf(service)).isLessThan(lines.indexOf(group))
        assertThat(service).matches("""  service gateway: utilization \d+\.\d+%, mean queue \d+\.\d+, failures \d+""")
        assertThat(group).contains("utilization ", "mean queue ", "failures ", "p99 ", "worst replica worker#2:")
        assertThat(result.stdout).doesNotContain("    replica ", "service worker#", "#lb")
    }

    @Test
    fun `replicas flag combines with workers and saved summary expands the same children`() {
        replicaModel()

        val result = execute(listOf("run", "--replicas", "--workers", "1", "replicas.experiment.json"))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val rows = result.stdout.lines().filter { it.startsWith("    replica ") }
        assertThat(rows).hasSize(3)
        rows.forEachIndexed { index, row ->
            assertThat(row)
                .matches("""    replica worker#${index + 1}: utilization \d+\.\d+%, mean queue \d+\.\d+, failures \d+""")
        }
        val runId =
            result.stdout
                .lineSequence()
                .first()
                .substringAfterLast('/')
        val saved = launch(listOf("summary", "--replicas", runId))
        assertThat(saved.exitCode).describedAs(saved.stderr).isZero()
        assertThat(saved.stdout).isEqualTo(result.stdout)
        assertThat(saved.stderr).isEmpty()
    }

    @Test
    fun `summary needs no input documents and leaves the artifact unchanged`() {
        replicaModel()
        val result = execute(listOf("run", "replicas.experiment.json"))
        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val directory = result.stdout.lineSequence().first()
        val before = artifactBytes(directory)
        Files.delete(workspace.resolve("replicas.model.json"))
        Files.delete(workspace.resolve("replicas.experiment.json"))

        val saved = execute(listOf("summary", directory.substringAfterLast('/')))

        assertThat(saved.exitCode).describedAs(saved.stderr).isZero()
        assertThat(saved.stdout).isEqualTo(result.stdout)
        assertThat(saved.stderr).isEmpty()
        val after = artifactBytes(directory)
        assertThat(after.keys).isEqualTo(before.keys)
        before.forEach { (path, bytes) -> assertThat(after.getValue(path)).describedAs(path).containsExactly(*bytes) }
    }

    @Test
    fun `group with no observations prints unavailable latency`() {
        replicaModel(rate = "0/s")

        val result = execute(listOf("run", "--replicas", "replicas.experiment.json"))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines()
        assertThat(lines.single { it.startsWith("  group worker:") }).contains("p99 n/a")
        assertThat(lines).contains("  service gateway: utilization 0.0%, mean queue 0.00, failures 0")
        (1..3).forEach { replica ->
            assertThat(lines).contains("    replica worker#$replica: utilization 0.0%, mean queue 0.00, failures 0")
        }
        assertThat(lines[1]).startsWith("baseline/p0: entry total: success n/a, p95 n/a, p99 n/a; ")
        assertThat(result.stdout).doesNotContain("entry client", "entry class", "failure reasons", "NaN", "Infinity")
    }

    @Test
    fun `zero capacity leaves utilization undefined while queue stays numeric`() {
        replicaModel(rate = "0/s")
        val file = workspace.resolve("replicas.experiment.json")
        file.writeText(
            file.readText().replace(
                """"target":"worker#2","from":"0ms","to":"1s","kind":"slowdown","multiplier":10""",
                """"target":"worker","from":"0ms","to":"1s","kind":"capacityLoss","capacity":0""",
            ),
        )

        val result = execute(listOf("run", "--replicas", "replicas.experiment.json"))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines()
        assertThat(lines.single { it.startsWith("  group worker:") }).contains("worst replica n/a: utilization n/a")
        (1..3).forEach { replica ->
            assertThat(lines).contains("    replica worker#$replica: utilization n/a, mean queue 0.00, failures 0")
        }
        assertThat(result.stdout).doesNotContain("NaN", "Infinity")
    }

    @Test
    fun `summary reports missing incomplete and unsupported artifacts without stdout`() {
        val missing = execute(listOf("summary", "missing"))
        assertThat(missing.exitCode).isEqualTo(2)
        assertThat(missing.stdout).isEmpty()
        assertThat(missing.stderr).contains("Run not found: missing")

        createIncomplete("unfinished")
        val incomplete = execute(listOf("summary", "unfinished"))
        assertThat(incomplete.exitCode).isEqualTo(2)
        assertThat(incomplete.stdout).isEmpty()
        assertThat(incomplete.stderr).containsIgnoringCase("incomplete")

        val result = execute(listOf("run", experiment))
        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val directory = workspace.resolve(result.stdout.lineSequence().first())
        listOf("manifest.json", "summary.json").forEach { name ->
            val file = directory.resolve(name)
            val original = file.readText()
            file.writeText(original.replace(Regex("\"schemaVersion\": \\d+"), "\"schemaVersion\": 0"))
            val unsupported = execute(listOf("summary", directory.fileName.toString()))
            assertThat(unsupported.exitCode).describedAs(name).isEqualTo(2)
            assertThat(unsupported.stdout).isEmpty()
            assertThat(unsupported.stderr).containsIgnoringCase("version").doesNotContain("\tat ")
            file.writeText(original)
        }
    }

    private fun replicaModel(rate: String = "300/s") {
        workspace.resolve("replicas.model.json").writeText(
            """
            {
              "schemaVersion": 6,
              "blocks": {
                "client": {"type":"client","params":{"deadline":"1s","load":{"points":[{"time":"0ms","rate":"$rate"}]}}},
                "gateway": {"type":"service","params":{"handlers":100,"queue":100,"processing":{"kind":"fixed","mean":"1ms"}}},
                "worker": {"type":"service","params":{"replicas":3,"handlers":1,"queue":100,"processing":{"kind":"fixed","mean":"2ms"}}}
              },
              "connections": [
                {"id":"entry","type":"request","from":"client","to":"gateway"},
                {"id":"call","type":"call","from":"gateway","to":"worker","params":{"timeout":"1s","attempts":1}}
              ]
            }
            """.trimIndent(),
        )
        workspace.resolve("replicas.experiment.json").writeText(
            """
            {
              "schemaVersion": 3,
              "modelRef": "replicas.model.json",
              "execution": {"seed":42,"warmup":"0ms","measurement":"1s","replications":2},
              "variants": [{"id":"baseline"}],
              "faults": [{"target":"worker#2","from":"0ms","to":"1s","kind":"slowdown","multiplier":10}]
            }
            """.trimIndent(),
        )
    }

    @Test
    fun `worker count does not change the result`() {
        execute(listOf("run", experiment))
        val first =
            workspace
                .resolve(
                    ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-1/summary.json",
                ).readText()

        val result = execute(listOf("run", "--workers", "1", experiment))

        assertThat(result.exitCode).isZero()
        assertThat(
            workspace.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-2/summary.json").readText(),
        ).isEqualTo(first)
    }

    @Test
    fun `run prints every grid point with document coordinates`() {
        val file = workspace.resolve(experiment)
        file.writeText(file.readText().replaceFirst("{", """{"grid":[{"path":"gateway-to-middle.timeout","values":["40ms","80ms"]}],"""))

        val result = execute(listOf("run", experiment))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        assertThat(lines).hasSize(5)
        assertThat(lines[1]).startsWith("baseline/p0 [gateway-to-middle.timeout=\"40ms\"]: entry total: success ")
        assertThat(lines[2]).startsWith("baseline/p1 [gateway-to-middle.timeout=\"80ms\"]: entry total: success ")
        assertThat(lines[3]).startsWith("no-retries/p0 [gateway-to-middle.timeout=\"40ms\"]: entry total: success ")
        assertThat(lines[4]).startsWith("no-retries/p1 [gateway-to-middle.timeout=\"80ms\"]: entry total: success ")
        assertThat(result.stderr).contains("Tasks 40/40")
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
    fun `estimate prints the core JSON without writing results`() {
        val expected = Lab(FileWorkspace(workspace)).use { it.estimate(experiment) }

        val result = execute(listOf("estimate", experiment))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        assertThat(result.stderr).isEmpty()
        assertThat(result.stdout)
            .isEqualTo(Json { encodeDefaults = true }.encodeToString(ExperimentEstimate.serializer(), expected) + "\n")
        assertThat(workspace.resolve(".results")).doesNotExist()
    }

    @Test
    fun `estimate reports invalid experiments and paths`() {
        breakModel()
        val invalid = execute(listOf("estimate", experiment))
        assertThat(invalid.exitCode).isEqualTo(2)
        assertThat(invalid.stdout).isEmpty()
        assertThat(invalid.stderr).contains("PARAM_MISSING")

        val outside = execute(listOf("estimate", "../outside.experiment.json"))
        assertThat(outside.exitCode).isEqualTo(2)
        assertThat(outside.stderr).contains("experiment must be inside the workspace")
    }

    @Test
    fun `resume by id matches continuous artifact bytes`() {
        assertResumeMatchesContinuous("run-2")
    }

    @Test
    fun `resume by absolute directory matches continuous artifact bytes`() {
        assertResumeMatchesContinuous(
            workspace.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-2").toString(),
        )
    }

    @Test
    fun `resume rejects unknown complete and escaping runs`() {
        val unknown = execute(listOf("resume", "missing"))
        assertThat(unknown.exitCode).isEqualTo(2)
        assertThat(unknown.stdout).isEmpty()
        assertThat(unknown.stderr).contains("Run not found: missing")

        assertThat(execute(listOf("run", experiment)).exitCode).isZero()
        val complete = execute(listOf("resume", "run-1"))
        assertThat(complete.exitCode).isEqualTo(2)
        assertThat(complete.stderr).contains("RUN_COMPLETE")

        val outside = execute(listOf("resume", "../outside"))
        assertThat(outside.exitCode).isEqualTo(2)
        assertThat(outside.stderr).contains("run must be inside the workspace")
    }

    @Test
    fun `pre cancelled resume returns 130 and keeps the incomplete artifact`() {
        createIncomplete("run-2")
        val stdout = StringBuilder()
        val stderr = StringBuilder()

        val status = runCommand(listOf("resume", "run-2"), stdout, stderr, workspace, isCancelled = { true })

        assertThat(status).isEqualTo(130)
        assertThat(stdout.toString()).isEmpty()
        assertThat(stderr.toString()).contains("Cancelled: .results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-2")
        assertThat(
            workspace.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-2/manifest.json").readText(),
        ).contains("\"complete\": false")
    }

    @Test
    fun `installed launcher prints estimate JSON and resumes a run`() {
        val estimate = launch(listOf("estimate", experiment))
        assertThat(estimate.exitCode).describedAs(estimate.stderr).isZero()
        assertThat(estimate.stderr).isEmpty()
        assertThat(Json.decodeFromString(ExperimentEstimate.serializer(), estimate.stdout).tasks).isEqualTo(20)

        createIncomplete("installed-resume")
        val resumed = launch(listOf("resume", "installed-resume"))
        assertThat(resumed.exitCode).describedAs(resumed.stderr).isZero()
        assertThat(
            resumed.stdout
                .lines()
                .filter { it.isNotBlank() }
                .first(),
        ).isEqualTo(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/installed-resume")
        assertThat(
            workspace
                .resolve(
                    ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/installed-resume/manifest.json",
                ).readText(),
        ).contains("\"complete\": true")
    }

    @Test
    fun `cancellation before execution returns 130 without claiming an artifact exists`() {
        val stdout = StringBuilder()
        val stderr = StringBuilder()

        val status = runCommand(listOf("run", experiment), stdout, stderr, workspace, isCancelled = { true })

        assertThat(status).isEqualTo(130)
        assertThat(stdout.toString()).isEmpty()
        assertThat(stderr.toString()).contains("Cancelled before an artifact was created").doesNotContain("Execution failed")
        assertThat(workspace.resolve(".results")).doesNotExist()
    }

    @Test
    fun `execution failures return 1 with a sanitized message`() {
        val result = execute(listOf("run", experiment)) { _, _, _, _, _ -> throw IllegalStateException("boom\n\tat somewhere") }

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
        assertThat(
            lines[0],
        ).matches("""\.results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/\d{8}-\d{6}-\d{3}-[0-9a-f]{4}""")
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

    @Test
    fun `installed launcher handles SIGINT and SIGTERM with an incomplete artifact and code 130`() {
        assumeFalse(System.getProperty("os.name").startsWith("Windows", ignoreCase = true))
        val file = workspace.resolve(experiment)
        file.writeText(file.readText().replace("\"replications\": 10", "\"replications\": 1000"))
        val launcher = Path.of("apps/cli/build/install/cli/bin/cli").toAbsolutePath()
        listOf("INT", "TERM").forEach { signal ->
            val output = workspace.resolve("stdout-$signal.log")
            val error = workspace.resolve("stderr-$signal.log")
            val process =
                ProcessBuilder(launcher.toString(), "run", "--workers", "1", experiment)
                    .directory(workspace.toFile())
                    .redirectOutput(output.toFile())
                    .redirectError(error.toFile())
                    .start()
            try {
                val deadline = System.nanoTime() + SECONDS.toNanos(30)
                while (!error.readText().contains("Tasks ")) {
                    check(process.isAlive && System.nanoTime() < deadline) { "CLI did not start: ${error.readText()}" }
                    Thread.sleep(20)
                }
                assertThat(ProcessBuilder("kill", "-$signal", process.pid().toString()).start().waitFor()).isZero()
                assertThat(process.waitFor(30, SECONDS)).isTrue()
                assertThat(process.exitValue()).describedAs("SIG$signal: ${error.readText()}").isEqualTo(130)
                assertThat(output.readText()).isEmpty()
                val directory = Regex("Cancelled: (.+)").find(error.readText())?.groupValues?.get(1)
                assertThat(directory).describedAs(error.readText()).isNotNull()
                val artifact = workspace.resolve(directory!!)
                assertThat(artifact.resolve("manifest.json").readText()).contains("\"complete\": false")
                assertThat(artifact.resolve("summary.json")).doesNotExist()
            } finally {
                if (process.isAlive) {
                    process.destroyForcibly()
                    process.waitFor(10, SECONDS)
                }
            }
        }
    }

    @Test
    fun `second SIGINT forces exit when cooperative cancellation cannot finish`() {
        assumeFalse(System.getProperty("os.name").startsWith("Windows", ignoreCase = true))
        val output = workspace.resolve("blocked-command.log")
        val classpath =
            Path.of("apps/cli/build/classes/kotlin/test").toAbsolutePath().toString() + File.pathSeparator +
                Path.of("apps/cli/build/install/cli/lib/*").toAbsolutePath()
        val process =
            ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp",
                classpath,
                SignalCancellationProcess::class.java.name,
            ).redirectErrorStream(true).redirectOutput(output.toFile()).start()

        fun awaitOutput(marker: String) {
            val deadline = System.nanoTime() + SECONDS.toNanos(30)
            while (!output.readText().contains(marker)) {
                check(process.isAlive && System.nanoTime() < deadline) { "Missing $marker: ${output.readText()}" }
                Thread.sleep(10)
            }
        }
        try {
            awaitOutput("READY")
            assertThat(ProcessBuilder("kill", "-INT", process.pid().toString()).start().waitFor()).isZero()
            awaitOutput("CANCELLING")
            assertThat(process.isAlive).isTrue()

            assertThat(ProcessBuilder("kill", "-INT", process.pid().toString()).start().waitFor()).isZero()
            assertThat(process.waitFor(5, SECONDS)).isTrue()
            assertThat(process.exitValue()).isEqualTo(130)
        } finally {
            if (process.isAlive) {
                process.destroyForcibly()
                process.waitFor(10, SECONDS)
            }
        }
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

    private fun assertResumeMatchesContinuous(argument: String) {
        assertThat(execute(listOf("run", experiment)).exitCode).isZero()
        val expectedDirectory = ".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-1"
        val expected = artifactBytes(expectedDirectory)
        createIncomplete("run-2")
        val missing =
            FileWorkspace(
                workspace,
            ).listFiles(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-2").first {
                it.endsWith("/replication.json.gz")
            }
        Files.delete(workspace.resolve(missing))

        val result = execute(listOf("resume", argument))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        assertThat(lines).hasSize(3)
        assertThat(lines[0]).isEqualTo(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-2")
        assertThat(result.stderr).contains("Tasks ")
        val actual = artifactBytes(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/run-2")
        assertThat(actual.keys).isEqualTo(expected.keys)
        expected.forEach { (path, bytes) ->
            assertThat(actual.getValue(path)).describedAs(path).containsExactly(*bytes)
        }
    }

    private fun createIncomplete(runId: String) {
        val cancelled = AtomicBoolean()
        assertThatThrownBy {
            Lab(FileWorkspace(workspace)).use { lab ->
                lab.run(experiment, runId, isCancelled = cancelled::get) { done, _ ->
                    if (done == 1) cancelled.set(true)
                }
            }
        }.isInstanceOf(CancellationException::class.java)
        val directory = workspace.resolve(".results/26318c50525ea0dca051f54916f6b8eeb27cd29956a9bf1ff6be770b1bafd10a/$runId")
        assertThat(directory.resolve("manifest.json").readText()).contains("\"complete\": false")
        assertThat(directory.resolve("summary.json")).doesNotExist()
    }

    private fun artifactBytes(directory: String): Map<String, ByteArray> =
        FileWorkspace(workspace).listFiles(directory).associate { path ->
            path.removePrefix("$directory/") to Files.readAllBytes(workspace.resolve(path))
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

/** A child process whose cleanup deliberately blocks after receiving the first cancellation request. */
private object SignalCancellationProcess {
    @JvmStatic
    fun main(args: Array<String>) {
        SignalCancellation().use { cancellation ->
            println("READY")
            while (!cancellation.isCancelled()) Thread.sleep(10)
            println("CANCELLING")
            CountDownLatch(1).await()
        }
    }
}
