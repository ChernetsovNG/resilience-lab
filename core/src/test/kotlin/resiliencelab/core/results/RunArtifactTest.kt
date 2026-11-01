package resiliencelab.core.results
import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.execution.ExperimentTask
import resiliencelab.core.experiment.AggregateEntries
import resiliencelab.core.experiment.AggregateEntryMetrics
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.EntryMetrics
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.experiment.LatencyStatistics
import resiliencelab.core.experiment.LatencySummary
import resiliencelab.core.experiment.ReplicationEntries
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunOutcome
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.test.Test

class RunArtifactTest {
    @Test
    fun `writes compressed canonical replication totals and hashes the stored bytes`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = ArtifactWriter(workspace)
        val directory = ".results/e/run-1/series/baseline/p0/rep-0"
        val result =
            ReplicationResult(
                entries =
                    ReplicationEntries(
                        EntryMetrics(
                            allLatency = LatencyStatistics(count = 2, sumMs = 30.0),
                            successfulLatency = LatencyStatistics(count = 1, sumMs = 10.0),
                            failedLatency = LatencyStatistics(count = 1, sumMs = 20.0),
                            originalArrivals = 2,
                            successes = 1,
                            failures = 1,
                        ),
                        emptyMap(),
                        emptyMap(),
                    ),
                arrivalTimesMs = listOf(1.0, 2.0),
                services = emptyMap(),
            )

        writer.writeReplication(directory, result, ReplicationSaturation(0, emptyList()))

        assertThat(workspace.exists("$directory/replication.json.gz")).isTrue()
        assertThat(workspace.exists("$directory/replication.json")).isFalse()
        val compressed = workspace.readBytes("$directory/replication.json.gz")
        assertThat(compressed.copyOfRange(4, 8)).containsExactly(0, 0, 0, 0)
        val text = GZIPInputStream(compressed.inputStream()).bufferedReader(Charsets.UTF_8).use { it.readText() }
        val artifact = Json.decodeFromString(ReplicationArtifact.serializer(), text)
        assertThat(artifact.result).isEqualTo(result.copy(arrivalTimesMs = emptyList()))
        assertThat(text).isEqualTo(
            DocumentCodec.encode(
                ReplicationArtifact.serializer(),
                ReplicationArtifact(
                    Versions.REPLICATION_SCHEMA,
                    LatencySketch.PROFILE,
                    "ms",
                    result,
                    ReplicationSaturation(0, emptyList()),
                ),
            ),
        )
        assertThat(text).doesNotContain("arrivalTimesMs")
        val written = writer.write(".results/e/run-1", manifest(), summary())
        assertThat(written.parts["series/baseline/p0/rep-0/replication.json.gz"]).isEqualTo(DocumentVersion.of(compressed))
    }

    @Test
    fun `places runs under the results directory by full experiment path`() {
        assertThat(ResultsLayout.runDirectory("examples/retry-storm.experiment.json", "run-1"))
            .isEqualTo(".results/06d2796e6e00ece390d4392ff92bb9fdab18859fecead1c363d8158781195ef9/run-1")
        assertThat(
            ResultsLayout.runDirectory("plain.json", "r"),
        ).isEqualTo(".results/2ddf0080b644f7448b80e31614b00b7670e8822683e09939030a32f634575ddd/r")
    }

    @Test
    fun `rejects run ids that leave the results directory`() {
        listOf("../..", "..", ".", "a/b", "", ".hidden").forEach { runId ->
            assertThatThrownBy { ResultsLayout.runDirectory("e.experiment.json", runId) }
                .describedAs(runId)
                .isInstanceOf(InvalidExperimentException::class.java)
        }
    }

    @Test
    fun `accepts Unicode experiment names without using them as directory segments`() {
        assertThat(ResultsLayout.runDirectory("Платёжный контур/Платёжный контур.experiment.json", "run-1"))
            .matches("\\.results/[a-f0-9]{64}/run-1")
    }

    @Test
    fun `different full experiment paths never share a results group`() {
        val paths =
            listOf(
                "one/shared.experiment.json",
                "two/shared.experiment.json",
                "Платёжный контур/Платёжный контур.experiment.json",
                "Платежный контур/Платежный контур.experiment.json",
            )
        assertThat(paths.map { ResultsLayout.runDirectory(it, "same-run") }).doesNotHaveDuplicates()
    }

    @Test
    fun `writes canonical summary then manifest with the summary checksum`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val written = ArtifactWriter(workspace).write(".results/e/run-1", manifest(), summary())

        val summaryText = workspace.read(".results/e/run-1/summary.json").text
        val manifestText = workspace.read(".results/e/run-1/manifest.json").text
        assertThat(summaryText).contains("\"replications\": 2").endsWith("}\n")
        assertThat(written.parts).containsExactlyEntriesOf(mapOf("summary.json" to DocumentVersion.of(summaryText)))
        assertThat(manifestText).contains("\"complete\": true").contains(DocumentVersion.of(summaryText))
        assertThat(manifestText.indexOf("\"e.experiment.json\"")).isLessThan(manifestText.indexOf("\"m.model.json\""))
    }

    @Test
    fun `rejects a repeated destination without changing either artifact`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = ArtifactWriter(workspace)
        writer.write(".results/e/run-1", manifest(), summary())
        val summaryPath = root.resolve(".results/e/run-1/summary.json")
        val manifestPath = root.resolve(".results/e/run-1/manifest.json")
        val originalSummary = Files.readAllBytes(summaryPath)
        val originalManifest = Files.readAllBytes(manifestPath)
        val originalSummaryVersion = DocumentVersion.of(String(originalSummary, Charsets.UTF_8))
        val originalManifestVersion = DocumentVersion.of(String(originalManifest, Charsets.UTF_8))

        assertThatThrownBy { writer.write(".results/e/run-1", manifest().copy(seed = 8), summary().copy(experiment = "replacement")) }
            .isInstanceOf(DocumentExistsException::class.java)

        assertThat(Files.readAllBytes(summaryPath).contentEquals(originalSummary)).isTrue()
        assertThat(Files.readAllBytes(manifestPath).contentEquals(originalManifest)).isTrue()
        assertThat(DocumentVersion.of(String(Files.readAllBytes(summaryPath), Charsets.UTF_8))).isEqualTo(originalSummaryVersion)
        assertThat(DocumentVersion.of(String(Files.readAllBytes(manifestPath), Charsets.UTF_8))).isEqualTo(originalManifestVersion)
    }

    @Test
    fun `rewrite replaces summary and manifest without hashing the old manifest`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = ArtifactWriter(workspace)
        writer.write(".results/e/run-1", manifest(), summary())

        val rewritten = writer.rewrite(".results/e/run-1", manifest().copy(seed = 9), summary().copy(experiment = "replacement"))

        val summaryText = workspace.read(".results/e/run-1/summary.json").text
        assertThat(summaryText).contains("replacement")
        assertThat(rewritten.parts).doesNotContainKey("manifest.json")
        assertThat(rewritten.parts["summary.json"]).isEqualTo(DocumentVersion.of(summaryText))
        assertThat(workspace.read(".results/e/run-1/manifest.json").text)
            .isEqualTo(DocumentCodec.encode(RunManifest.serializer(), rewritten))
    }

    @Test
    fun `incomplete rewrite removes a previously written summary`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val writer = ArtifactWriter(workspace)
        writer.write(".results/e/run-1", manifest(), summary())

        val rewritten = writer.rewrite(".results/e/run-1", manifest().copy(complete = false), null)

        assertThat(workspace.exists(".results/e/run-1/summary.json")).isFalse()
        assertThat(rewritten.complete).isFalse()
        assertThat(rewritten.parts).doesNotContainKey("summary.json").doesNotContainKey("manifest.json")
    }

    @Test
    fun `rejects a manifest-only destination without creating a summary`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val manifestPath = ".results/e/run-1/manifest.json"
        val originalManifest = DocumentCodec.encode(RunManifest.serializer(), manifest())
        workspace.create(manifestPath, originalManifest)

        assertThatThrownBy { ArtifactWriter(workspace).write(".results/e/run-1", manifest(), summary()) }
            .isInstanceOf(DocumentExistsException::class.java)

        assertThat(workspace.exists(".results/e/run-1/summary.json")).isFalse()
        assertThat(workspace.read(manifestPath).text).isEqualTo(originalManifest)
    }

    @Test
    fun `prepare selects only the task with a bad file checksum`(
        @TempDir root: Path,
    ) {
        listOf("replication.json.gz", "index.json", "part-0.json.gz").forEach { fileName ->
            val caseRoot = root.resolve(fileName)
            Files.createDirectories(caseRoot)
            val outcome = runExample(caseRoot)
            val workspace = FileWorkspace(caseRoot)
            val tasks = exampleTasks()
            val target = tasks.first()
            val targetDirectory = "${outcome.runDirectory}/series/${target.variant}/${target.point}/rep-${target.replication}"
            val validPath = "${outcome.runDirectory}/series/baseline/p0/rep-1/replication.json.gz"
            val validBytes = workspace.readBytes(validPath)
            val corrupted = caseRoot.resolve("$targetDirectory/$fileName")
            if (fileName.endsWith(".gz")) {
                Files.write(corrupted, byteArrayOf(1, 2, 3))
            } else {
                Files.writeString(corrupted, "corrupted")
            }

            val invalid = ResumeArtifact(workspace).prepare(outcome.runDirectory, outcome.manifest.copy(complete = false), tasks)

            assertThat(invalid).containsExactly(target)
            assertThat(workspace.readBytes(validPath)).isEqualTo(validBytes)
            assertThat(workspace.exists("${outcome.runDirectory}/summary.json")).isFalse()
        }
    }

    @Test
    fun `prepare removes incomplete and unrelated files but preserves valid tasks`(
        @TempDir root: Path,
    ) {
        val outcome = runExample(root)
        val workspace = FileWorkspace(root)
        val tasks = exampleTasks()
        val target = tasks[2]
        val targetDirectory = "${outcome.runDirectory}/series/${target.variant}/${target.point}/rep-${target.replication}"
        Files.delete(root.resolve("$targetDirectory/replication.json.gz"))
        workspace.create("$targetDirectory/stale.json", "stale")
        workspace.create("${outcome.runDirectory}/orphan.json", "orphan")
        val validPath = "${outcome.runDirectory}/series/baseline/p0/rep-0/replication.json.gz"
        val validBytes = workspace.readBytes(validPath)

        val invalid = ResumeArtifact(workspace).prepare(outcome.runDirectory, outcome.manifest.copy(complete = false), tasks)

        assertThat(invalid).containsExactly(target)
        assertThat(workspace.listFiles(targetDirectory)).isEmpty()
        assertThat(workspace.exists("${outcome.runDirectory}/orphan.json")).isFalse()
        assertThat(workspace.exists("${outcome.runDirectory}/summary.json")).isFalse()
        assertThat(workspace.readBytes(validPath)).isEqualTo(validBytes)
    }

    @Test
    fun `prepare checks the compressed replication bytes even when their JSON is unchanged`(
        @TempDir root: Path,
    ) {
        val outcome = runExample(root)
        val workspace = FileWorkspace(root)
        val tasks = exampleTasks()
        val target = tasks.first()
        val path = "${outcome.runDirectory}/series/${target.variant}/${target.point}/rep-${target.replication}/replication.json.gz"
        val original = workspace.readBytes(path)
        val changed = original.copyOf().also { it[4] = 1 }
        assertThat(GZIPInputStream(changed.inputStream()).use { it.readAllBytes() })
            .isEqualTo(GZIPInputStream(original.inputStream()).use { it.readAllBytes() })
        Files.write(root.resolve(path), changed)

        val invalid = ResumeArtifact(workspace).prepare(outcome.runDirectory, outcome.manifest.copy(complete = false), tasks)

        assertThat(invalid).containsExactly(target)
    }

    @Test
    fun `old replication version is rejected before decoding its obsolete result shape`(
        @TempDir root: Path,
    ) {
        val workspace = FileWorkspace(root)
        val directory = ".results/e/old"
        val bytes =
            ByteArrayOutputStream()
                .also { buffer ->
                    GZIPOutputStream(buffer).use { it.write("{\"schemaVersion\":6,\"result\":{}}".toByteArray()) }
                }.toByteArray()
        workspace.createBytes("$directory/series/baseline/p0/rep-0/replication.json.gz", bytes)
        assertThatThrownBy {
            ArtifactWriter(workspace).summarize(
                directory,
                "e.experiment.json",
                listOf("baseline" to "Baseline"),
                1,
                listOf(GridPoint("p0", emptyMap())),
                emptyList(),
            )
        }.isInstanceOf(UnsupportedArtifactVersionException::class.java)
            .hasMessageContaining("replication schemaVersion 6")
            .hasMessageContaining("expected 7")
            .hasMessageContaining("run again")
    }

    private fun exampleTasks() =
        listOf("baseline", "no-retries").flatMap { variant ->
            (0 until 2).map { replication -> ExperimentTask(variant, "p0", replication) }
        }

    private fun runExample(root: Path): RunOutcome {
        val source = Path.of(System.getProperty("resilience-lab.project-root"), "examples", "retry-storm")
        val directory = Files.createDirectories(root.resolve("retry-storm"))
        for (file in listOf("retry-storm.model.json", "retry-storm.layout.json", "retry-storm.experiment.json")) {
            Files.copy(source.resolve(file), directory.resolve(file))
        }
        return Lab(FileWorkspace(root)).use { it.run("retry-storm/retry-storm.experiment.json", "r") }
    }

    private fun summary() =
        RunSummary(
            schemaVersion = 1,
            experiment = "e.experiment.json",
            variants =
                listOf(
                    VariantSummary(
                        "baseline",
                        "Baseline",
                        2,
                        listOf(
                            PointSummary(
                                "p0",
                                emptyMap(),
                                AggregateMetrics(
                                    entries =
                                        AggregateEntries(
                                            AggregateEntryMetrics(LatencySummary(null, null, null), null, null, null),
                                            emptyMap(),
                                            emptyMap(),
                                        ),
                                    services = emptyMap(),
                                ),
                                SaturationSummary(
                                    SaturationRule(),
                                    2,
                                    emptyList(),
                                    listOf(ReplicationSaturation(0, emptyList()), ReplicationSaturation(1, emptyList())),
                                ),
                            ),
                        ),
                    ),
                ),
            grid = emptyList(),
        )

    private fun manifest() =
        RunManifest(
            schemaVersion = 1,
            applicationVersion = Versions.APPLICATION,
            kslVersion = Versions.KSL,
            streamAssignment = "v1",
            experiment = "e.experiment.json",
            documents = mapOf("m.model.json" to "b", "e.experiment.json" to "a"),
            seed = 7,
            replications = 2,
            variants = listOf("baseline"),
            parts = emptyMap(),
            complete = true,
            grid = emptyList(),
        )
}
