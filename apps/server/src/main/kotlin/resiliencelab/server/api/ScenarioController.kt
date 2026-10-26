package resiliencelab.server.api

import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.scenario.ValidationIssue

/** Exposes scenario submission validation independently of experiment execution. */
@RestController
class ScenarioController(
    private val experimentService: ExperimentService,
) {
    /** Validates and prepares a submission, returning no job or execution result. */
    @PostMapping(
        "/api/v1/scenarios/validate",
        consumes = [MediaType.APPLICATION_JSON_VALUE],
        produces = [MediaType.APPLICATION_JSON_VALUE],
    )
    fun validate(
        @RequestBody body: String,
    ): ValidationReport {
        experimentService.prepare(ExperimentSubmissionCodec.decode(body))
        return ValidationReport(valid = true, issues = emptyList())
    }
}

/** Reports whether a submitted experiment or sweep passed execution preparation. */
data class ValidationReport(
    val valid: Boolean,
    val issues: List<ValidationIssue>,
)
