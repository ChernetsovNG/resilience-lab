package resiliencelab.server.lab

import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.Diagnostic

/** Stable message definitions used by API problems and process-local job failures. */
enum class ServerMessage(
    val code: String,
    val reason: String?,
    val template: String,
) {
    SERIES_PATH_ADDRESS("SERIES_PATH", "address", "Invalid run series path"),
    SERIES_PATH_NUMBER("SERIES_PATH", "number", "Replication and part must be nonnegative int32 numbers without leading zeros"),
    RUN_VERSION_VERSION(
        "RUN_VERSION_UNSUPPORTED",
        "version",
        "Unsupported {kind} schemaVersion {actual}; expected {expectedSchema}; run again",
    ),
    RUN_VERSION_MISSING(
        "RUN_VERSION_UNSUPPORTED",
        "missing",
        "Unsupported {kind} schemaVersion missing; expected {expectedSchema}; run again",
    ),
    EXPERIMENT_INVALID("EXPERIMENT_INVALID", null, "Experiment has errors"),
    DOCUMENT_PATH("DOCUMENT_PATH", null, "Path '{path}' is not a relative path inside the workspace"),
    REQUEST_INVALID("REQUEST_INVALID", null, "Request body or parameters are invalid"),
    RUN_INCOMPLETE("RUN_INCOMPLETE", null, "Run '{id}' is incomplete"),
    DOCUMENT_NOT_FOUND("DOCUMENT_NOT_FOUND", null, "Document '{path}' does not exist"),
    VERSION_CONFLICT_MATCH("VERSION_CONFLICT", "ifMatch", "Document '{path}' is not at a version that If-Match accepts"),
    VERSION_CONFLICT_VERSION("VERSION_CONFLICT", "version", "Document '{path}' has version {actual}, not the expected {expected}"),
    VERSION_CONFLICT_MISSING("VERSION_CONFLICT", "versionMissing", "Document '{path}' has version none, not the expected {expected}"),
    VERSION_REQUIRED_CREATE("VERSION_REQUIRED", "create", "Document '{path}' already exists; send If-Match with its version"),
    VERSION_REQUIRED_DELETE("VERSION_REQUIRED", "delete", "If-Match is required to delete '{path}'"),
    STORAGE_ERROR("STORAGE_ERROR", null, "Workspace storage failed"),
    DOCUMENT_INVALID_STORED("DOCUMENT_INVALID", "stored", "Stored document '{path}' is invalid"),
    DOCUMENT_INVALID_INPUT("DOCUMENT_INVALID", "input", "Document '{path}' is invalid"),
    DOCUMENT_KIND_CONTENT("DOCUMENT_KIND", "content", "Content must hold exactly one document of the kind of '{path}'"),
    DOCUMENT_KIND_PATH("DOCUMENT_KIND", "path", "'{path}' is not a model, layout or experiment document"),
    DRAFT_PATH("DRAFT_PATH", null, "Draft document paths must be unique"),
    CURSOR_INVALID("CURSOR_INVALID", null, "Change cursor must have a valid generation and non-negative sequence"),
    SERIES_NOT_FOUND("SERIES_NOT_FOUND", null, "Run series does not exist"),
    RUN_NOT_FOUND("RUN_NOT_FOUND", null, "Run '{id}' does not exist"),
    JOB_NOT_FOUND("JOB_NOT_FOUND", null, "Job '{id}' does not exist"),
    JOB_FINISHED("JOB_FINISHED", null, "Job '{id}' has already finished"),
    RUN_COMPLETE("RUN_COMPLETE", "api", "Run '{id}' is already complete"),
    JOB_QUEUE_FULL("JOB_QUEUE_FULL", null, "Job queue is full"),
    EXPERIMENT_EXECUTION_FAILED("EXPERIMENT_EXECUTION_FAILED", null, "Experiment execution failed"),
    ;

    /** Scalar context, including a discriminator for codes that have more than one meaning. */
    fun args(values: Map<String, JsonPrimitive> = emptyMap()): Map<String, JsonPrimitive> =
        if (reason == null) values else mapOf("reason" to JsonPrimitive(reason)) + values

    /** Keeps legacy text intact while adding structured context for clients that localize messages. */
    fun problem(
        legacyMessage: String,
        diagnostics: List<Diagnostic> = emptyList(),
        args: Map<String, JsonPrimitive> = emptyMap(),
    ): ApiProblem = ApiProblem(code, legacyMessage, diagnostics, this.args(args))
}
