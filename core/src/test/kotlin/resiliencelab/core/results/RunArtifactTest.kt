package resiliencelab.core.results

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.LatencySummary
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class RunArtifactTest {
    @Test
    fun `places runs under the results directory by experiment name`() {
        assertThat(ResultsLayout.runDirectory("examples/retry-storm.experiment.json", "run-1"))
            .isEqualTo(".results/retry-storm/run-1")
        assertThat(ResultsLayout.runDirectory("plain.json", "r")).isEqualTo(".results/plain.json/r")
    }

    @Test
    fun `rejects run ids and experiment names that leave the results directory`() {
        listOf("../..", "..", ".", "a/b", "", ".hidden").forEach { runId ->
            assertThatThrownBy { ResultsLayout.runDirectory("e.experiment.json", runId) }
                .describedAs(runId)
                .isInstanceOf(IllegalArgumentException::class.java)
        }
        assertThatThrownBy { ResultsLayout.runDirectory("..experiment.json", "run-1") }
            .isInstanceOf(IllegalArgumentException::class.java)
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
                                AggregateMetrics(LatencySummary(null, null, null), null, null, null, emptyMap()),
                            ),
                        ),
                    ),
                ),
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
        )
}
