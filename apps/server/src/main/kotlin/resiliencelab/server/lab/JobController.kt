package resiliencelab.server.lab

import kotlinx.serialization.json.JsonPrimitive
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/** Jobs: the UI polls `GET /jobs/{id}` (ADR 0010, item 4). */
@RestController
@RequestMapping("/api/v1/jobs")
class JobController(
    private val jobs: JobService,
) {
    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun submitJob(
        @RequestBody request: ExperimentRequest,
    ): JobView = jobs.submit(request.experiment)

    @GetMapping
    fun listJobs(): List<JobView> = jobs.list()

    @GetMapping("/{id}")
    fun getJob(
        @PathVariable id: String,
    ): JobView =
        jobs.get(id) ?: throw NotFound(
            ServerMessage.JOB_NOT_FOUND,
            "Job '$id' does not exist",
            mapOf("id" to JsonPrimitive(id)),
        )

    /** Requests cancellation; repeated requests remain accepted, while completed or failed jobs return `JOB_FINISHED`. */
    @PostMapping("/{id}/cancel")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun cancelJob(
        @PathVariable id: String,
    ): JobView =
        jobs.cancel(id) ?: throw NotFound(
            ServerMessage.JOB_NOT_FOUND,
            "Job '$id' does not exist",
            mapOf("id" to JsonPrimitive(id)),
        )
}
