package resiliencelab.core.results

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import kotlin.test.Test

class RunCatalogTest {
    private val workspace = FileWorkspace(Files.createTempDirectory("run-catalog"))
    private val catalog = RunCatalog(workspace)

    private fun finish(
        directory: String,
        experiment: String,
        complete: Boolean = true,
    ) {
        val manifest =
            RunManifest(
                schemaVersion = Versions.ARTIFACT_SCHEMA,
                applicationVersion = Versions.APPLICATION,
                kslVersion = Versions.KSL,
                streamAssignment = "v1",
                experiment = experiment,
                documents = emptyMap(),
                seed = 7,
                replications = 1,
                variants = emptyList(),
                parts = emptyMap(),
                complete = complete,
                grid = emptyList(),
            )
        ArtifactWriter(workspace).write(directory, manifest, RunSummary(Versions.ARTIFACT_SCHEMA, experiment, emptyList(), emptyList()))
    }

    @Test
    fun `lists finished runs newest first and reads their parts`() {
        finish(".results/a/20261027-090000-000-0001", "a.experiment.json")
        finish(".results/b/20261027-100000-000-0002", "b.experiment.json")
        workspace.write(".results/a/20261027-110000-000-0003/summary.json", "{}\n")

        assertThat(catalog.list().map { it.id }).containsExactly("20261027-100000-000-0002", "20261027-090000-000-0001")
        assertThat(catalog.list().first().copy(sizeBytes = 0))
            .isEqualTo(RunEntry("20261027-100000-000-0002", "b.experiment.json", ".results/b/20261027-100000-000-0002", true))
        assertThat(catalog.entry("20261027-090000-000-0001")?.complete).isTrue()
        assertThat(catalog.manifest("20261027-090000-000-0001")!!.experiment).isEqualTo("a.experiment.json")
        assertThat(catalog.summary("20261027-090000-000-0001")!!.experiment).isEqualTo("a.experiment.json")
        assertThat(catalog.manifest("missing")).isNull()
        assertThat(catalog.summary("missing")).isNull()
    }

    @Test
    fun `skips runs with unreadable manifests`() {
        finish(".results/a/r1", "a.experiment.json")
        workspace.write(".results/a/r2/manifest.json", "{")

        assertThat(catalog.list().map { it.id }).containsExactly("r1")
    }

    @Test
    fun `lists an incomplete run but rejects only its summary`() {
        finish(".results/a/r1", "a.experiment.json", complete = false)
        val entry = RunEntry("r1", "a.experiment.json", ".results/a/r1", false)

        assertThat(catalog.list().map { it.copy(sizeBytes = 0) }).containsExactly(entry)
        assertThat(catalog.entry("r1")?.copy(sizeBytes = 0)).isEqualTo(entry)
        assertThat(catalog.manifest("r1")?.complete).isFalse()
        assertThatThrownBy { catalog.summary("r1") }
            .isInstanceOf(RunIncompleteException::class.java)
            .hasMessageContaining("r1")
    }

    @Test
    fun `is empty without results`() {
        assertThat(catalog.list()).isEmpty()
    }

    @Test
    fun `explicit reads of old artifacts report unsupported versions before decoding`() {
        (1 until Versions.ARTIFACT_SCHEMA).forEach { version ->
            workspace.create(".results/old/r-old-$version/manifest.json", "{\"schemaVersion\":$version}")
            assertThat(catalog.list()).isEmpty()
            assertThatThrownBy { catalog.manifest("r-old-$version") }
                .isInstanceOf(UnsupportedArtifactVersionException::class.java)
                .hasMessageContaining("schemaVersion $version")
                .hasMessageContaining("expected ${Versions.ARTIFACT_SCHEMA}")
        }
    }
}
