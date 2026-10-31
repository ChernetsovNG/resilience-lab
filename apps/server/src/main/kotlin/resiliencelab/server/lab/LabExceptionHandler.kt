package resiliencelab.server.lab

import kotlinx.serialization.json.JsonPrimitive
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestControllerAdvice
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.results.InvalidRunPathException
import resiliencelab.core.results.InvalidSeriesPathException
import resiliencelab.core.results.RunIncompleteException
import resiliencelab.core.results.UnsupportedArtifactVersionException
import resiliencelab.core.results.Versions
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentNotFoundException
import resiliencelab.core.workspace.InvalidDocumentPathException
import resiliencelab.core.workspace.VersionConflictException
import java.io.IOException

/** Failures of the stage 1 API; each subclass maps to one documented status. */
sealed class ApiException(
    private val definition: ServerMessage,
    override val message: String,
    val diagnostics: List<Diagnostic> = emptyList(),
    val args: Map<String, JsonPrimitive> = emptyMap(),
) : RuntimeException(message) {
    val code: String = definition.code

    fun problem(): ApiProblem = definition.problem(message, diagnostics, args)
}

class BadRequest(
    definition: ServerMessage,
    message: String,
    diagnostics: List<Diagnostic> = emptyList(),
    args: Map<String, JsonPrimitive> = emptyMap(),
) : ApiException(definition, message, diagnostics, args)

class PreconditionRequired(
    definition: ServerMessage,
    message: String,
    args: Map<String, JsonPrimitive> = emptyMap(),
) : ApiException(definition, message, args = args)

class NotFound(
    definition: ServerMessage,
    message: String,
    args: Map<String, JsonPrimitive> = emptyMap(),
) : ApiException(definition, message, args = args)

class Conflict(
    definition: ServerMessage,
    message: String,
    diagnostics: List<Diagnostic> = emptyList(),
    args: Map<String, JsonPrimitive> = emptyMap(),
) : ApiException(definition, message, diagnostics, args)

/**
 * Maps failures of the stage 1 endpoints to [ApiProblem]. Every handler declares its status with `@ResponseStatus`,
 * so springdoc documents the error responses.
 * Series addresses use `SERIES_PATH` (400) for invalid segments and `SERIES_NOT_FOUND` (404) for missing data.
 * Job cancellation uses `JOB_NOT_FOUND` (404) and `JOB_FINISHED` (409).
 * Workspace deletion uses `VERSION_REQUIRED` (428); malformed change cursors use `CURSOR_INVALID` (400).
 * Resume uses `RUN_NOT_FOUND` (404), `RUN_INCOMPLETE` (404), `RUN_COMPLETE` (409), and core diagnostics (400).
 * Run deletion uses `RUN_NOT_FOUND` (404), `RUN_ACTIVE` (409) and `RUN_PATH` (400).
 * Experiment document deletion uses `EXPERIMENT_ACTIVE` (409) while its Run/Resume is queued or running.
 * Job failures use `JOB_QUEUE_FULL`, `EXPERIMENT_INVALID`, and `EXPERIMENT_EXECUTION_FAILED` in [JobView.errorCode].
 * Known execution failures retain `EXECUTION_REAL_TIME_LIMIT`, `EXECUTION_DRAIN`, `EXECUTION_TIME`, and `SERIES_PART_LIMIT`.
 * Invalid run identifiers are reported as an `EXPERIMENT_INVALID` job with a `RUN_ID` core diagnostic.
 */
@RestControllerAdvice(basePackageClasses = [LabExceptionHandler::class])
class LabExceptionHandler {
    @ExceptionHandler(InvalidRunPathException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidRunPath(exception: InvalidRunPathException): ApiProblem =
        ServerMessage.RUN_PATH.problem(exception.message!!, args = mapOf("path" to JsonPrimitive(exception.path)))

    @ExceptionHandler(InvalidSeriesPathException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidSeriesPath(exception: InvalidSeriesPathException): ApiProblem =
        ServerMessage.SERIES_PATH_ADDRESS.problem(exception.message!!)

    @ExceptionHandler(UnsupportedArtifactVersionException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun unsupportedRunVersion(exception: UnsupportedArtifactVersionException): ApiProblem {
        val definition = if (exception.actual == null) ServerMessage.RUN_VERSION_MISSING else ServerMessage.RUN_VERSION_VERSION
        val args =
            buildMap {
                put("kind", JsonPrimitive(exception.kind))
                put("expectedSchema", JsonPrimitive(Versions.ARTIFACT_SCHEMA))
                exception.actual?.let { put("actual", JsonPrimitive(it)) }
            }
        return definition.problem(exception.message ?: "Unsupported run format; run again", args = args)
    }

    @ExceptionHandler(PreconditionRequired::class)
    @ResponseStatus(HttpStatus.PRECONDITION_REQUIRED)
    fun preconditionRequired(exception: PreconditionRequired): ApiProblem = exception.problem()

    @ExceptionHandler(BadRequest::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun badRequest(exception: BadRequest): ApiProblem = exception.problem()

    @ExceptionHandler(InvalidExperimentException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidExperiment(exception: InvalidExperimentException): ApiProblem =
        ServerMessage.EXPERIMENT_INVALID.problem("Experiment has errors", exception.diagnostics)

    @ExceptionHandler(InvalidDocumentPathException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidPath(exception: InvalidDocumentPathException): ApiProblem =
        ServerMessage.DOCUMENT_PATH.problem(
            exception.message ?: "Invalid document path",
            args = mapOf("path" to JsonPrimitive(exception.path)),
        )

    @ExceptionHandler(HttpMessageNotReadableException::class, MissingServletRequestParameterException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun unreadable(): ApiProblem = ServerMessage.REQUEST_INVALID.problem("Request body or parameters are invalid")

    @ExceptionHandler(NotFound::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun notFound(exception: NotFound): ApiProblem = exception.problem()

    @ExceptionHandler(RunIncompleteException::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun incompleteRun(exception: RunIncompleteException): ApiProblem =
        ServerMessage.RUN_INCOMPLETE.problem(exception.message!!, args = mapOf("id" to JsonPrimitive(exception.id)))

    @ExceptionHandler(DocumentNotFoundException::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun documentNotFound(exception: DocumentNotFoundException): ApiProblem =
        ServerMessage.DOCUMENT_NOT_FOUND.problem(
            exception.message ?: "Document not found",
            args = mapOf("path" to JsonPrimitive(exception.path)),
        )

    @ExceptionHandler(Conflict::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun conflict(exception: Conflict): ApiProblem = exception.problem()

    @ExceptionHandler(VersionConflictException::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun versionConflict(exception: VersionConflictException): ApiProblem {
        val definition = if (exception.actual == null) ServerMessage.VERSION_CONFLICT_MISSING else ServerMessage.VERSION_CONFLICT_VERSION
        val args =
            buildMap {
                put("path", JsonPrimitive(exception.path))
                put("expected", JsonPrimitive(exception.expected))
                exception.actual?.let { put("actual", JsonPrimitive(it)) }
            }
        return definition.problem(exception.message ?: "Document version conflict", args = args)
    }

    @ExceptionHandler(DocumentExistsException::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun documentExists(exception: DocumentExistsException): ApiProblem =
        ServerMessage.VERSION_REQUIRED_CREATE.problem(
            "${exception.message}; send If-Match with its version",
            args = mapOf("path" to JsonPrimitive(exception.path)),
        )

    @ExceptionHandler(IOException::class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    fun storageFailure(exception: IOException): ApiProblem {
        logger.error("Workspace storage failed", exception)
        return ServerMessage.STORAGE_ERROR.problem("Workspace storage failed")
    }

    private companion object {
        val logger = LoggerFactory.getLogger(LabExceptionHandler::class.java)
    }
}
