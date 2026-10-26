package resiliencelab.core.scenario

data class ValidationIssue(
    val path: String,
    val message: String,
)

class ScenarioValidationException(
    val errors: List<ValidationIssue>,
) : IllegalArgumentException(
    errors.joinToString(prefix = "Scenario validation failed: ", separator = "; ") {
        "${it.path}: ${it.message}"
    },
)
