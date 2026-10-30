package resiliencelab.server.lab

import io.swagger.v3.oas.annotations.media.Schema
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.LayoutFile
import resiliencelab.core.document.ModelFile

// API types follow the rules of the server plan: plain @Serializable classes, no @SerialName, @Transient, custom
// serializers or polymorphism, because springdoc derives the schema from Kotlin properties and kotlinx writes the JSON.

/**
 * Error body of the stage 1 API (stage 1 design §4.1). [args] carries raw string/number values for localization;
 * [message] remains the legacy English text.
 */
@Serializable
data class ApiProblem(
    val code: String,
    val message: String,
    val diagnostics: List<Diagnostic> = emptyList(),
    val args: Map<String, JsonPrimitive>? = null,
)

/** Server status and versions. */
@Serializable
data class HealthView(
    val status: String,
    val applicationVersion: String,
    val kslVersion: String,
)

typealias DocumentKind = resiliencelab.core.workspace.DocumentKind

/** A workspace document without its content. */
@Serializable
data class DocumentEntry(
    val path: String,
    val kind: DocumentKind,
    val version: String,
    /** Raw relative model reference for a decodable experiment; null for other or malformed documents. */
    val modelRef: String? = null,
)

/** Document content: exactly the property of the document kind is set. */
@Serializable
data class DocumentContent(
    val model: ModelFile? = null,
    val layout: LayoutFile? = null,
    val experiment: ExperimentFile? = null,
)

/** A document with its version; the same version is sent as `ETag`. */
@Serializable
data class DocumentView(
    val path: String,
    val kind: DocumentKind,
    val version: String,
    val content: DocumentContent,
)

/** One workspace document mutation; a null [version] denotes deletion. */
@Serializable
data class WorkspaceChangeView(
    val path: String,
    val kind: DocumentKind,
    val version: String?,
)

/** A bounded change feed response with an opaque process-generation cursor and a reset signal for stale cursors. */
@Serializable
data class WorkspaceChangesView(
    val cursor: String,
    val reset: Boolean,
    val changes: List<WorkspaceChangeView>,
)

/** Names an experiment document of the workspace. */
@Serializable
data class ExperimentRequest(
    val experiment: String,
)

/** In-memory content at a canonical workspace-relative path; validation never saves it. */
@Serializable
data class DocumentDraft(
    val path: String,
    val content: DocumentContent,
)

/** Experiment with optional in-memory replacements used by validation and estimation; drafts are never saved. */
@Serializable
data class ValidationRequest(
    val experiment: String,
    @field:Schema(requiredMode = Schema.RequiredMode.NOT_REQUIRED)
    val drafts: List<DocumentDraft> = emptyList(),
)

/** Diagnostics of one experiment; [valid] is false when any diagnostic is an error. */
@Serializable
data class ValidationView(
    val experiment: String,
    val valid: Boolean,
    val diagnostics: List<Diagnostic>,
)

/** Lifecycle of a process-local job. */
@Serializable
enum class JobStatus {
    QUEUED,
    RUNNING,
    COMPLETED,
    FAILED,
    CANCELLED,
}

/**
 * Snapshot of a job: one run of one experiment; [totalTasks] is known after the first task finishes.
 * [cancelRequested] records a cancellation request; a running job only becomes [JobStatus.CANCELLED] after it stops.
 * [errorCode] and [errorArgs] localize a failure while [error] keeps its legacy text; successful and cancelled jobs have no error.
 */
@Serializable
data class JobView(
    val id: String,
    val experiment: String,
    val runId: String,
    val status: JobStatus,
    val completedTasks: Int,
    val totalTasks: Int,
    val cancelRequested: Boolean = false,
    val error: String? = null,
    val diagnostics: List<Diagnostic> = emptyList(),
    val errorCode: String? = null,
    val errorArgs: Map<String, JsonPrimitive>? = null,
)
