package resiliencelab.core.results

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
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
        find(id)?.let { json.decodeFromString(RunSummary.serializer(), workspace.read("${it.directory}/$SUMMARY_FILE").text) }

    private fun find(id: String): RunEntry? = list().firstOrNull { it.id == id }

    private fun readManifest(directory: String): RunManifest =
        json.decodeFromString(RunManifest.serializer(), workspace.read("$directory/$MANIFEST_FILE").text)

    private companion object {
        const val RESULTS = ".results"
        const val MANIFEST_FILE = "manifest.json"
        const val SUMMARY_FILE = "summary.json"
        val MANIFEST = Regex("""^\.results/[^/]+/[^/]+/manifest\.json$""")
    }
}
