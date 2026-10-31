package resiliencelab.core.results

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.workspace.DocumentNotFoundException
import resiliencelab.core.workspace.FileWorkspace
import resiliencelab.core.workspace.VersionedDocument
import resiliencelab.core.workspace.Workspace
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.FileTime
import kotlin.test.Test

class RunCatalogTest {
    private val root = Files.createTempDirectory("run-catalog")
    private val workspace = FileWorkspace(root)
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
        ArtifactWriter(workspace).write(
            directory,
            manifest,
            if (complete) RunSummary(Versions.ARTIFACT_SCHEMA, experiment, emptyList(), emptyList()) else null,
        )
    }

    @Test
    fun `lists finished runs newest first and reads their parts`() {
        finish(".results/a/20261027-090000-000-0001", "a.experiment.json")
        finish(".results/b/20261027-100000-000-0002", "b.experiment.json")
        workspace.write(".results/a/20261027-110000-000-0003/summary.json", "{}\n")

        assertThat(catalog.list().map { it.id }).containsExactly("20261027-100000-000-0002", "20261027-090000-000-0001")
        assertThat(catalog.list().first().copy(sizeBytes = 0, completedAt = null))
            .isEqualTo(RunEntry("20261027-100000-000-0002", "b.experiment.json", ".results/b/20261027-100000-000-0002", true))
        assertThat(catalog.entry("20261027-090000-000-0001")?.complete).isTrue()
        assertThat(catalog.manifest("20261027-090000-000-0001")!!.experiment).isEqualTo("a.experiment.json")
        assertThat(catalog.summary("20261027-090000-000-0001")!!.experiment).isEqualTo("a.experiment.json")
        assertThat(catalog.manifest("missing")).isNull()
        assertThat(catalog.summary("missing")).isNull()
    }

    @Test
    fun `completion time follows manifest publication including a resumed older run`() {
        finish(".results/a/older", "a.experiment.json")
        finish(".results/a/newer", "a.experiment.json")
        finish(".results/a/incomplete", "a.experiment.json", complete = false)
        Files.setLastModifiedTime(root.resolve(".results/a/older/manifest.json"), FileTime.fromMillis(2000))
        Files.setLastModifiedTime(root.resolve(".results/a/newer/manifest.json"), FileTime.fromMillis(1000))

        fun completedAt(entry: RunEntry): Long? {
            val body = Json.encodeToJsonElement(RunEntry.serializer(), entry).jsonObject
            return body["completedAt"]?.jsonPrimitive?.longOrNull
        }

        assertThat(completedAt(catalog.entry("older")!!)).isEqualTo(2000L)
        assertThat(completedAt(catalog.entry("newer")!!)).isEqualTo(1000L)
        assertThat(completedAt(catalog.entry("incomplete")!!)).isNull()
        assertThat(catalog.list().map(::completedAt)).contains(2000L, 1000L, null)
    }

    @Test
    fun `a missing summary retains completed status and does not hide an unfinished run`() {
        val experiment = "a.experiment.json"
        val pending = ResultsLayout.runDirectory(experiment, "a-pending")
        val completed = ResultsLayout.runDirectory(experiment, "z-completed")
        finish(pending, experiment, complete = false)
        finish(completed, experiment)
        workspace.delete("$completed/summary.json")

        val latest = catalog.latest(experiment)
        assertThat(latest.map { it.id }).containsExactly("z-completed", "a-pending")
        assertThat(latest.map { it.complete }).containsExactly(true, false)
        assertThatThrownBy { catalog.summary("z-completed") }.isInstanceOf(DocumentNotFoundException::class.java)
        workspace.delete(ResultsLayout.completionMarker(completed))
        assertThat(catalog.latest(experiment).map { it.id }).containsExactly("z-completed", "a-pending")
        assertThat(catalog.deleteDirectory(completed)).isTrue()
        assertThat(workspace.exists(ResultsLayout.completionMarker(completed))).isFalse()
    }

    @Test
    fun `completion metadata failure does not discard a published result`() {
        val experiment = "a.experiment.json"
        val directory = ResultsLayout.runDirectory(experiment, "complete")
        finish(directory, experiment)
        val manifest = catalog.manifest("complete")!!
        val summary = catalog.summary("complete")!!
        val marker = ResultsLayout.completionMarker(directory)
        workspace.delete(marker)
        val observed =
            object : Workspace by workspace {
                override fun write(
                    path: String,
                    text: String,
                    expectedVersion: String?,
                ): String {
                    if (path == marker) throw IOException("Completion metadata unavailable")
                    return workspace.write(path, text, expectedVersion)
                }
            }

        assertThat(ArtifactWriter(observed).rewrite(directory, manifest, summary).complete).isTrue()
        assertThat(catalog.latest(experiment).single().id).isEqualTo("complete")
        assertThat(catalog.summary("complete")).isEqualTo(summary)
    }

    @Test
    fun `latest selection reads only selected manifests and no summaries`() {
        val experiment = "a.experiment.json"
        repeat(100) { index ->
            val directory = ResultsLayout.runDirectory(experiment, "run-${index.toString().padStart(3, '0')}")
            finish(directory, experiment)
            Files.setLastModifiedTime(root.resolve("$directory/manifest.json"), FileTime.fromMillis(index * 1000L))
        }
        val pending = ResultsLayout.runDirectory(experiment, "pending")
        finish(pending, experiment, complete = false)
        finish(ResultsLayout.runDirectory("other/a.experiment.json", "foreign"), "other/a.experiment.json")
        val reads = mutableListOf<String>()
        val observed =
            object : Workspace by workspace {
                override fun read(path: String): VersionedDocument {
                    reads += path
                    return workspace.read(path)
                }
            }

        assertThat(RunCatalog(observed).latest(experiment).map { it.id }).containsExactly("run-099", "pending")
        assertThat(reads).containsExactlyInAnyOrder(
            "${ResultsLayout.runDirectory(experiment, "run-099")}/manifest.json",
            "$pending/manifest.json",
        )
        assertThat(RunCatalog(observed).latest("empty.experiment.json")).isEmpty()

        val unsupported = ResultsLayout.runDirectory(experiment, "unsupported")
        finish(unsupported, experiment)
        workspace.write("$unsupported/manifest.json", """{"schemaVersion":1}""")
        Files.setLastModifiedTime(root.resolve("$unsupported/manifest.json"), FileTime.fromMillis(200000))
        reads.clear()
        assertThat(RunCatalog(observed).latest(experiment).map { it.id }).containsExactly("pending")
        assertThat(reads).hasSize(2)
    }

    @Test
    fun `reading a run does not recursively scan all stored parts`() {
        finish(".results/a/target", "a.experiment.json")
        var recursiveScans = 0
        val observed =
            object : Workspace by workspace {
                override fun listFiles(directory: String): List<String> {
                    if (directory == ".results") recursiveScans++
                    return workspace.listFiles(directory)
                }
            }

        assertThat(RunCatalog(observed).manifest("target")?.experiment).isEqualTo("a.experiment.json")
        assertThat(recursiveScans).isZero()
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
