package resiliencelab.server.lab

import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.execution.ExperimentEstimate
import resiliencelab.core.lab.Lab

/** Pre-run cost estimates with the same optional in-memory drafts as validation. */
@RestController
class EstimateController(
    private val lab: Lab,
) {
    @PostMapping("/api/v1/estimate")
    fun estimateExperiment(
        @RequestBody request: ValidationRequest,
    ): ExperimentEstimate = lab.estimate(request.experiment, Documents.draftTexts(request.drafts))
}
