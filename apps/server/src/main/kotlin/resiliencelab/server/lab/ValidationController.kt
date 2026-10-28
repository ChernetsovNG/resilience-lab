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
        @RequestBody request: ValidationRequest,
    ): ValidationView {
        val drafts =
            request.drafts.associate { draft ->
                val kind =
                    DocumentKind.of(draft.path)
                        ?: throw BadRequest("DOCUMENT_KIND", "'${draft.path}' is not a model, layout or experiment document")
                val text =
                    Documents.encode(kind, draft.content)
                        ?: throw BadRequest("DOCUMENT_KIND", "Content must hold exactly one document of the kind of '${draft.path}'")
                draft.path to text
            }
        if (drafts.size != request.drafts.size) throw BadRequest("DRAFT_PATH", "Draft document paths must be unique")
        val report = lab.validate(request.experiment, drafts)
        return ValidationView(report.experimentPath, report.valid, report.diagnostics)
    }
}
