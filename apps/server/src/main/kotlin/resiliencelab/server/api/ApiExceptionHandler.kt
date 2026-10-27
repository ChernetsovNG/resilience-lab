package resiliencelab.server.api

import kotlinx.serialization.SerializationException
import org.springframework.http.HttpStatus
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestControllerAdvice
import resiliencelab.core.scenario.ScenarioValidationException
import resiliencelab.core.scenario.ValidationIssue

/** Maps submission failures to stable API errors without exposing exception or filesystem details. */
@RestControllerAdvice(assignableTypes = [ExperimentController::class, ScenarioController::class])
class ApiExceptionHandler {
    /** Returns core validation diagnostics while keeping the top-level message generic. */
    @ExceptionHandler(ScenarioValidationException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun handleValidation(exception: ScenarioValidationException): ApiError =
        ApiError(
            code = "INVALID_SUBMISSION",
            message = "Invalid experiment submission",
            issues = exception.errors,
        )

    /** Rejects malformed, structurally invalid, and unsupported submissions with sanitized diagnostics. */
    @ExceptionHandler(SerializationException::class, IllegalArgumentException::class, HttpMessageNotReadableException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun handleInvalidSubmission(): ApiError =
        ApiError(
            code = "INVALID_SUBMISSION",
            message = "Invalid experiment submission",
            issues = emptyList(),
        )
}

/** A stable API error with optional path-qualified scenario validation issues. */
data class ApiError(
    val code: String,
    val message: String,
    val issues: List<ValidationIssue>,
)
