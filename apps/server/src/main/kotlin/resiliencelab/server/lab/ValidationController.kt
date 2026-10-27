package resiliencelab.server.lab

import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.lab.Lab

/** Diagnostics of an experiment of the workspace; missing documents are diagnostics too. */
@RestController
class ValidationController(
    private val lab: Lab,
) {
    @PostMapping("/api/v1/validate")
    fun validateExperiment(
        @RequestBody request: ExperimentRequest,
    ): ValidationView {
        val report = lab.validate(request.experiment)
        return ValidationView(report.experimentPath, report.valid, report.diagnostics)
    }
}
