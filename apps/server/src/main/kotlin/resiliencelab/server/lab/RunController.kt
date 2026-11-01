package resiliencelab.server.lab

import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.media.Content
import io.swagger.v3.oas.annotations.media.Schema
import io.swagger.v3.oas.annotations.responses.ApiResponse
import kotlinx.serialization.json.JsonPrimitive
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.results.AggregateSeriesIndex
import resiliencelab.core.results.AggregateSeriesPart
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.results.RunEntry
import resiliencelab.core.results.RunManifest
import resiliencelab.core.results.RunStorageEntry
import resiliencelab.core.results.RunSummary
import resiliencelab.core.results.SeriesIndex
import resiliencelab.core.results.SeriesPart
import resiliencelab.core.results.StoredSeriesPart
import java.io.IOException
import java.time.Duration

/** Complete and incomplete runs from `.results/`; they outlive server restarts, jobs do not. */
@RestController
@RequestMapping("/api/v1/runs")
class RunController(
    private val runs: RunCatalog,
    private val jobs: JobService,
) {
    @GetMapping
    @Throws(IOException::class)
    fun listRuns(): List<RunEntry> = runs.list()

    @GetMapping("/latest")
    @Throws(IOException::class)
    fun getLatestRuns(
        @RequestParam experiment: String,
    ): List<RunEntry> = runs.latest(experiment)

    @GetMapping("/obsolete")
    @Throws(IOException::class)
    fun listObsoleteRuns(): List<RunStorageEntry> {
        val obsolete = runs.obsolete()
        val active =
            jobs
                .list()
                .filter { it.status == JobStatus.QUEUED || it.status == JobStatus.RUNNING }
                .map { it.runId }
                .toSet()
        return obsolete.filter { it.id !in active && runs.isObsolete(it.directory) }
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Throws(IOException::class)
    fun deleteRun(
        @PathVariable id: String,
    ) {
        jobs.withIdleRun(id) { deleteStoredRun(runs.stored(id) ?: throw notFound(id)) }
    }

    /** Directory addressing also covers runs without a readable manifest and equal IDs in different groups. */
    @DeleteMapping
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Throws(IOException::class)
    fun deleteRunDirectory(
        @RequestParam directory: String,
    ) {
        jobs.withIdleRun(directory.substringAfterLast('/')) {
            deleteStoredRun(runs.storedDirectory(directory) ?: throw notFound(directory))
        }
    }

    private fun deleteStoredRun(entry: RunStorageEntry) {
        jobs.withIdleRun(entry.id, entry.experiment) {
            if (!runs.deleteDirectory(entry.directory)) throw notFound(entry.id)
        }
    }

    @GetMapping("/{id}/manifest")
    @Throws(IOException::class)
    fun getRunManifest(
        @PathVariable id: String,
    ): RunManifest = runs.manifest(id) ?: throw notFound(id)

    @PostMapping("/{id}/resume")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun resumeRun(
        @PathVariable id: String,
    ): JobView = jobs.resume(runs.entry(id) ?: throw notFound(id))

    @GetMapping("/{id}/summary")
    @Throws(IOException::class)
    fun getRunSummary(
        @PathVariable id: String,
    ): RunSummary = runs.summary(id) ?: throw notFound(id)

    @GetMapping("/{id}/series/{variant}/{cell}/{rep}")
    @Throws(IOException::class)
    fun getRunSeriesIndex(
        @PathVariable id: String,
        @PathVariable variant: String,
        @PathVariable cell: String,
        @Parameter(schema = Schema(type = "integer", format = "int32", minimum = "0"))
        @PathVariable rep: String,
    ): SeriesIndex = runs.seriesIndex(id, variant, cell, seriesNumber(rep)) ?: throw seriesNotFound()

    @GetMapping("/{id}/series/{variant}/{cell}/aggregate")
    @Throws(IOException::class)
    fun getRunAggregateSeriesIndex(
        @PathVariable id: String,
        @PathVariable variant: String,
        @PathVariable cell: String,
    ): AggregateSeriesIndex = runs.aggregateSeriesIndex(id, variant, cell) ?: throw seriesNotFound()

    /** Decoded aggregate output schema; the response carries the unchanged, checksummed gzip bytes. */
    @GetMapping("/{id}/series/{variant}/{cell}/aggregate/{part}", produces = [MediaType.APPLICATION_JSON_VALUE])
    @ApiResponse(
        responseCode = "200",
        description = "Original aggregate gzip part; Content-Encoding: gzip. Clients decode it as AggregateSeriesPart.",
        content = [Content(mediaType = MediaType.APPLICATION_JSON_VALUE, schema = Schema(implementation = AggregateSeriesPart::class))],
    )
    @Throws(IOException::class)
    fun getRunAggregateSeriesPart(
        @PathVariable id: String,
        @PathVariable variant: String,
        @PathVariable cell: String,
        @Parameter(schema = Schema(type = "integer", format = "int32", minimum = "0"))
        @PathVariable part: String,
    ): ResponseEntity<ByteArray> = gzipPart(runs.aggregateSeriesPart(id, variant, cell, seriesNumber(part)) ?: throw seriesNotFound())

    /** The response schema describes the decoded JSON; the wire body is the original gzip file. */
    @GetMapping("/{id}/series/{variant}/{cell}/{rep}/{part}", produces = [MediaType.APPLICATION_JSON_VALUE])
    @ApiResponse(
        responseCode = "200",
        description = "Original gzip part; Content-Encoding: gzip. Clients decode it as SeriesPart.",
        content = [Content(mediaType = MediaType.APPLICATION_JSON_VALUE, schema = Schema(implementation = SeriesPart::class))],
    )
    @Throws(IOException::class)
    fun getRunSeriesPart(
        @PathVariable id: String,
        @PathVariable variant: String,
        @PathVariable cell: String,
        @Parameter(schema = Schema(type = "integer", format = "int32", minimum = "0"))
        @PathVariable rep: String,
        @Parameter(schema = Schema(type = "integer", format = "int32", minimum = "0"))
        @PathVariable part: String,
    ): ResponseEntity<ByteArray> =
        gzipPart(runs.seriesPart(id, variant, cell, seriesNumber(rep), seriesNumber(part)) ?: throw seriesNotFound())

    private fun gzipPart(stored: StoredSeriesPart): ResponseEntity<ByteArray> =
        ResponseEntity
            .ok()
            .contentType(MediaType.APPLICATION_JSON)
            .header(HttpHeaders.CONTENT_ENCODING, "gzip")
            .eTag("\"${stored.sha256}\"")
            .cacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePublic().immutable())
            .body(stored.bytes)

    private fun seriesNumber(value: String): Int =
        value.takeIf { Regex("0|[1-9][0-9]*").matches(it) }?.toIntOrNull()
            ?: throw BadRequest(
                ServerMessage.SERIES_PATH_NUMBER,
                "Replication and part must be nonnegative int32 numbers without leading zeros",
            )

    private fun seriesNotFound() = NotFound(ServerMessage.SERIES_NOT_FOUND, "Run series does not exist")

    private fun notFound(id: String) = NotFound(ServerMessage.RUN_NOT_FOUND, "Run '$id' does not exist", mapOf("id" to JsonPrimitive(id)))
}
