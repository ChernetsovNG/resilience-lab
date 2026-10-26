package resiliencelab.core.scenario

/** A validation diagnostic addressed to a field or element in the input document. */
data class ValidationIssue(
    val path: String,
    val message: String,
)

/** Reports the complete set of issues found by a `requireValid` validation entry point. */
class ScenarioValidationException(
    val errors: List<ValidationIssue>,
) : IllegalArgumentException(
        errors.joinToString(prefix = "Scenario validation failed: ", separator = "; ") {
            "${it.path}: ${it.message}"
        },
    )
