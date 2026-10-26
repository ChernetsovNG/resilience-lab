package resiliencelab.server.api

import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import resiliencelab.server.experiment.ExperimentJob
import resiliencelab.server.experiment.ExperimentJobManager
import resiliencelab.server.experiment.ExperimentJobStatus
import java.util.UUID

/** Exposes process-local experiment submission, lifecycle polling, and completed results. */
@RestController
class ExperimentController(
    private val experimentService: ExperimentService,
    private val jobManager: ExperimentJobManager,
) {
    /** Validates and prepares a submission before queueing its asynchronous execution. */
    @PostMapping(
        "/api/v1/experiments",
        consumes = [MediaType.APPLICATION_JSON_VALUE],
        produces = [MediaType.APPLICATION_JSON_VALUE],
    )
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun submit(
        @RequestBody body: String,
    ): ExperimentJobResponse {
        val document = experimentService.prepare(ExperimentSubmissionCodec.decode(body))
        val id = jobManager.submit(document)
        return ExperimentJobResponse(id, ExperimentJobStatus.QUEUED)
    }

    /** Returns the latest public lifecycle snapshot for one experiment job. */
    @GetMapping("/api/v1/experiments/{id}", produces = [MediaType.APPLICATION_JSON_VALUE])
    fun getJob(
        @PathVariable id: UUID,
    ): ResponseEntity<Any> {
        val job = jobManager.get(id) ?: return notFound()
        return ResponseEntity.ok(job.toResponse())
    }

    /** Returns a completed result, or a stable error when it is missing, unfinished, or failed. */
    @GetMapping("/api/v1/experiments/{id}/result", produces = [MediaType.APPLICATION_JSON_VALUE])
    fun getResult(
        @PathVariable id: UUID,
    ): ResponseEntity<Any> {
        val job = jobManager.get(id) ?: return notFound()
        return when (job.status) {
            ExperimentJobStatus.QUEUED, ExperimentJobStatus.RUNNING ->
                error(
                    HttpStatus.CONFLICT,
                    "EXPERIMENT_NOT_COMPLETED",
                    "Experiment result is not available",
                )
            ExperimentJobStatus.FAILED ->
                error(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "EXPERIMENT_FAILED",
                    job.error ?: "Experiment execution failed",
                )
            ExperimentJobStatus.COMPLETED ->
                job.result?.let { ResponseEntity.ok(it) }
                    ?: error(HttpStatus.NOT_FOUND, "EXPERIMENT_NOT_FOUND", "Experiment not found")
        }
    }

    private fun ExperimentJob.toResponse() = ExperimentJobResponse(id, status)

    private fun notFound(): ResponseEntity<Any> = error(HttpStatus.NOT_FOUND, "EXPERIMENT_NOT_FOUND", "Experiment not found")

    private fun error(
        status: HttpStatus,
        code: String,
        message: String,
    ): ResponseEntity<Any> =
        ResponseEntity
            .status(status)
            .body(ApiError(code = code, message = message, issues = emptyList()))
}

/** Public identifier and lifecycle state returned after submission and during polling. */
data class ExperimentJobResponse(
    val id: UUID,
    val status: ExperimentJobStatus,
)
