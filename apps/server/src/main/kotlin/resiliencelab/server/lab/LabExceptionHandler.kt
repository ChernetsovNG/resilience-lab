package resiliencelab.server.lab

import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestControllerAdvice
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentNotFoundException
import resiliencelab.core.workspace.InvalidDocumentPathException
import resiliencelab.core.workspace.VersionConflictException
import java.io.IOException

/** Failures of the stage 1 API; each subclass maps to one documented status. */
sealed class ApiException(
    val code: String,
    override val message: String,
    val diagnostics: List<Diagnostic> = emptyList(),
) : RuntimeException(message) {
    fun problem(): ApiProblem = ApiProblem(code, message, diagnostics)
}

class BadRequest(
    code: String,
    message: String,
    diagnostics: List<Diagnostic> = emptyList(),
) : ApiException(code, message, diagnostics)

class NotFound(
    code: String,
    message: String,
) : ApiException(code, message)

class Conflict(
    code: String,
    message: String,
    diagnostics: List<Diagnostic> = emptyList(),
) : ApiException(code, message, diagnostics)

/**
 * Maps failures of the stage 1 endpoints to [ApiProblem]. Every handler declares its status with `@ResponseStatus`,
 * so springdoc documents the error responses.
 */
@RestControllerAdvice(basePackageClasses = [LabExceptionHandler::class])
class LabExceptionHandler {
    @ExceptionHandler(BadRequest::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun badRequest(exception: BadRequest): ApiProblem = exception.problem()

    @ExceptionHandler(InvalidExperimentException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidExperiment(exception: InvalidExperimentException): ApiProblem =
        ApiProblem("EXPERIMENT_INVALID", "Experiment has errors", exception.diagnostics)

    @ExceptionHandler(InvalidDocumentPathException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidPath(exception: InvalidDocumentPathException): ApiProblem =
        ApiProblem("DOCUMENT_PATH", exception.message ?: "Invalid document path")

    @ExceptionHandler(HttpMessageNotReadableException::class, MissingServletRequestParameterException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun unreadable(): ApiProblem = ApiProblem("REQUEST_INVALID", "Request body or parameters are invalid")

    @ExceptionHandler(NotFound::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun notFound(exception: NotFound): ApiProblem = exception.problem()

    @ExceptionHandler(DocumentNotFoundException::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun documentNotFound(exception: DocumentNotFoundException): ApiProblem =
        ApiProblem("DOCUMENT_NOT_FOUND", exception.message ?: "Document not found")

    @ExceptionHandler(Conflict::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun conflict(exception: Conflict): ApiProblem = exception.problem()

    @ExceptionHandler(VersionConflictException::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun versionConflict(exception: VersionConflictException): ApiProblem =
        ApiProblem("VERSION_CONFLICT", exception.message ?: "Document version conflict")

    @ExceptionHandler(DocumentExistsException::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun documentExists(exception: DocumentExistsException): ApiProblem =
        ApiProblem("VERSION_REQUIRED", "${exception.message}; send If-Match with its version")

    @ExceptionHandler(IOException::class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    fun storageFailure(exception: IOException): ApiProblem {
        logger.error("Workspace storage failed", exception)
        return ApiProblem("STORAGE_ERROR", "Workspace storage failed")
    }

    private companion object {
        val logger = LoggerFactory.getLogger(LabExceptionHandler::class.java)
    }
}
