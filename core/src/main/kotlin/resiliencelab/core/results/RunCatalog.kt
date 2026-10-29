package resiliencelab.core.results

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.workspace.DocumentNotFoundException
import resiliencelab.core.workspace.Workspace

/** A run with a readable manifest and its persisted completion state (ADR 0008). */
@Serializable
data class RunEntry(
    val id: String,
    val experiment: String,
    val directory: String,
    val complete: Boolean,
)

/** Original gzip bytes and their SHA-256 from the task index. */
data class StoredSeriesPart(
    val bytes: ByteArray,
    val sha256: String,
)

/** A series address contains an invalid identifier or a negative replication/part number. */
class InvalidSeriesPathException : IllegalArgumentException("Invalid run series path")

/** A summary cannot be read before the run has been completed and its summary published. */
class RunIncompleteException(
    val id: String,
) : RuntimeException("Run '$id' is incomplete")

/** Finds complete and incomplete runs under `.results/<experiment>/<run>/`. */
class RunCatalog(
    private val workspace: Workspace,
) {
    /** Parts are written without `null` values, so missing nullable fields read as `null`. */
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json { explicitNulls = false }

    /** Runs with readable manifests, newest first; unreadable manifests are skipped. */
    fun list(): List<RunEntry> =
        workspace
            .listFiles(RESULTS)
            .filter { MANIFEST.matches(it) }
            .mapNotNull { path ->
                val directory = path.removeSuffix("/$MANIFEST_FILE")
                runCatching { readManifest(directory) }
                    .getOrNull()
                    ?.let { RunEntry(directory.substringAfterLast('/'), it.experiment, directory, it.complete) }
            }.sortedWith(compareByDescending<RunEntry> { it.id }.thenBy { it.directory })

    fun entry(id: String): RunEntry? = find(id)

    fun manifest(id: String): RunManifest? = find(id)?.let { readManifest(it.directory) }

    fun summary(id: String): RunSummary? =
        find(id)?.let {
            if (!it.complete) throw RunIncompleteException(id)
            val text = workspace.read("${it.directory}/$SUMMARY_FILE").text
            checkVersion(text, "summary")
            json.decodeFromString(RunSummary.serializer(), text)
        }

    /** Reads a finished task's index; an unknown run or task returns `null`. */
    fun seriesIndex(
        id: String,
        variant: String,
        cell: String,
        rep: Int,
    ): SeriesIndex? = seriesDirectory(id, variant, cell, rep)?.let { readSeriesIndex(it) }

    /** Reads only a part named by the index, without decompressing or re-encoding its stored gzip bytes. */
    fun seriesPart(
        id: String,
        variant: String,
        cell: String,
        rep: Int,
        part: Int,
    ): StoredSeriesPart? {
        if (part < 0) throw InvalidSeriesPathException()
        val directory = seriesDirectory(id, variant, cell, rep) ?: return null
        val reference = readSeriesIndex(directory)?.parts?.find { it.file == "part-$part.json.gz" } ?: return null
        val bytes = readSeriesFile(directory, reference.file) ?: return null
        return StoredSeriesPart(bytes, reference.sha256)
    }

    private fun seriesDirectory(
        id: String,
        variant: String,
        cell: String,
        rep: Int,
    ): String? {
        if (!RUN_ID.matches(id) || !ModelCompiler.ID.matches(variant) || !CELL.matches(cell) || rep < 0) {
            throw InvalidSeriesPathException()
        }
        return find(id)?.let { "${it.directory}/series/$variant/$cell/rep-$rep" }
    }

    private fun readSeriesIndex(directory: String): SeriesIndex? =
        readSeriesFile(directory, "index.json")?.let { json.decodeFromString<SeriesIndex>(it.toString(Charsets.UTF_8)) }

    private fun readSeriesFile(
        directory: String,
        file: String,
    ): ByteArray? {
        val path = "$directory/$file"
        // Listing from the run root excludes symbolic links in every series path component.
        val runDirectory = directory.split('/').take(3).joinToString("/")
        if (path !in workspace.listFiles(runDirectory)) return null
        return try {
            workspace.readBytes(path)
        } catch (_: DocumentNotFoundException) {
            null
        }
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
            return RunEntry(id, manifest.experiment, directory, manifest.complete)
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
        val RUN_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
        val CELL = Regex("^p(0|[1-9][0-9]*)$")
    }
}
