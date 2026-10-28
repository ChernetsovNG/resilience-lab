package resiliencelab.core.results

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import resiliencelab.core.workspace.Workspace

/** A finished run: its manifest exists and says the run is complete (ADR 0008). */
@Serializable
data class RunEntry(
    val id: String,
    val experiment: String,
    val directory: String,
)

/** Finds finished runs under `.results/<experiment>/<run>/`. */
class RunCatalog(
    private val workspace: Workspace,
) {
    /** Parts are written without `null` values, so missing nullable fields read as `null`. */
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json { explicitNulls = false }

    /** Finished runs, newest first; incomplete runs and runs whose manifest cannot be read are skipped. */
    fun list(): List<RunEntry> =
        workspace
            .listFiles(RESULTS)
            .filter { MANIFEST.matches(it) }
            .mapNotNull { path ->
                val directory = path.removeSuffix("/$MANIFEST_FILE")
                runCatching { readManifest(directory) }
                    .getOrNull()
                    ?.takeIf { it.complete }
                    ?.let { RunEntry(directory.substringAfterLast('/'), it.experiment, directory) }
            }.sortedWith(compareByDescending<RunEntry> { it.id }.thenBy { it.directory })

    fun manifest(id: String): RunManifest? = find(id)?.let { readManifest(it.directory) }

    fun summary(id: String): RunSummary? =
        find(id)?.let {
            val text = workspace.read("${it.directory}/$SUMMARY_FILE").text
            checkVersion(text, "summary")
            json.decodeFromString(RunSummary.serializer(), text)
        }

    private fun find(id: String): RunEntry? {
        for (path in workspace.listFiles(RESULTS).filter { MANIFEST.matches(it) }) {
            val directory = path.removeSuffix("/$MANIFEST_FILE")
            if (directory.substringAfterLast('/') != id) continue
            val manifest =
                try {
                    readManifest(directory)
                } catch (failure: UnsupportedArtifactVersionException) {
                    throw failure
                } catch (_: Exception) {
                    continue
                }
            if (manifest.complete) return RunEntry(id, manifest.experiment, directory)
        }
        return null
    }

    private fun readManifest(directory: String): RunManifest {
        val text = workspace.read("$directory/$MANIFEST_FILE").text
        checkVersion(text, "manifest")
        return json.decodeFromString(RunManifest.serializer(), text)
    }

    private fun checkVersion(
        text: String,
        kind: String,
    ) {
        val version =
            json
                .parseToJsonElement(text)
                .jsonObject["schemaVersion"]
                ?.jsonPrimitive
                ?.intOrNull
        if (version != Versions.ARTIFACT_SCHEMA) throw UnsupportedArtifactVersionException(kind, version)
    }

    private companion object {
        const val RESULTS = ".results"
        const val MANIFEST_FILE = "manifest.json"
        const val SUMMARY_FILE = "summary.json"
        val MANIFEST = Regex("""^\.results/[^/]+/[^/]+/manifest\.json$""")
    }
}
