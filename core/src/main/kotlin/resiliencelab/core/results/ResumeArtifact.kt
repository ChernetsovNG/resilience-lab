package resiliencelab.core.results

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import resiliencelab.core.execution.ExperimentTask
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.Workspace

/** Selects invalid tasks and removes stale files before an in-place resume. */
internal class ResumeArtifact(
    private val workspace: Workspace,
) {
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json { explicitNulls = false }

    fun prepare(
        runDirectory: String,
        manifest: RunManifest,
        tasks: Collection<ExperimentTask>,
    ): Set<ExperimentTask> {
        val taskDirectories = tasks.associateWith { it.directory(runDirectory) }
        workspace.delete("$runDirectory/summary.json")
        workspace.listFiles(runDirectory).forEach { path ->
            if (path != "$runDirectory/manifest.json" && taskDirectories.values.none { directory -> path.startsWith("$directory/") }) {
                workspace.delete(path)
            }
        }
        val invalid = tasks.filterNot { task -> isValid(runDirectory, manifest, taskDirectories.getValue(task)) }
        invalid.forEach { task ->
            workspace.listFiles(taskDirectories.getValue(task)).forEach(workspace::delete)
        }
        return invalid.toCollection(linkedSetOf())
    }

    private fun isValid(
        runDirectory: String,
        manifest: RunManifest,
        directory: String,
    ): Boolean =
        try {
            val replicationPath = "$directory/replication.json"
            val indexPath = "$directory/index.json"
            val replication = json.decodeFromString(ReplicationArtifact.serializer(), workspace.read(replicationPath).text)
            if (replication.schemaVersion != Versions.REPLICATION_SCHEMA ||
                replication.profile != LatencySketch.PROFILE ||
                replication.unit != "ms"
            ) {
                return false
            }
            val index = json.decodeFromString(SeriesIndex.serializer(), workspace.read(indexPath).text)
            val series = manifest.series ?: return false
            if (
                index.schemaVersion != Versions.SERIES_SCHEMA ||
                index.endMs != series.warmupMs + series.measurementMs ||
                index.windowMs != series.windowMs ||
                index.parts.isEmpty()
            ) {
                return false
            }
            val files = index.parts.map { it.file }
            if (files.distinct().size != files.size || files.any { !PART_FILE.matches(it) }) return false
            val expected = setOf(replicationPath, indexPath) + files.map { "$directory/$it" }
            if (workspace.listFiles(directory).toSet() != expected) return false
            if (!checksumMatches(runDirectory, replicationPath, manifest) || !checksumMatches(runDirectory, indexPath, manifest)) {
                return false
            }
            index.parts.all { reference ->
                val path = "$directory/${reference.file}"
                val relative = path.removePrefix("$runDirectory/")
                manifest.parts[relative] == reference.sha256 && DocumentVersion.of(workspace.readBytes(path)) == reference.sha256
            }
        } catch (_: Exception) {
            false
        }

    private fun checksumMatches(
        runDirectory: String,
        path: String,
        manifest: RunManifest,
    ): Boolean {
        val expected = manifest.parts[path.removePrefix("$runDirectory/")] ?: return false
        return DocumentVersion.of(workspace.readBytes(path)) == expected
    }

    private companion object {
        val PART_FILE = Regex("part-(0|[1-9][0-9]*)\\.json\\.gz")
    }
}
