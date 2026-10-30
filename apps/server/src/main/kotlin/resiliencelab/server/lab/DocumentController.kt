package resiliencelab.server.lab

import io.swagger.v3.oas.annotations.Parameter
import kotlinx.serialization.json.JsonPrimitive
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.workspace.Workspace
import resiliencelab.core.workspace.WorkspaceCursor
import java.io.IOException

/**
 * Workspace documents with versions (ADR 0003, ADR 0010). The path is a query parameter because it contains `/`.
 * Without `If-Match` a write only creates a new document; with it the stored version must match. A failed condition
 * is 409, as the project decided. Deletion always requires `If-Match`. Stored text is always canonical.
 * The changes endpoint exposes the bounded workspace journal, including API writes and external file mutations.
 */
@RestController
@RequestMapping("/api/v1/workspace")
class DocumentController(
    private val workspace: Workspace,
) {
    @GetMapping("/documents")
    @Throws(IOException::class)
    fun listDocuments(): List<DocumentEntry> =
        workspace.list().mapNotNull { path ->
            DocumentKind.of(path)?.let { kind ->
                val document = workspace.read(path)
                val modelRef =
                    if (kind == DocumentKind.EXPERIMENT) {
                        (Documents.decode(kind, document.text, path) as? DecodeResult.Ok)?.value?.experiment?.modelRef
                    } else {
                        null
                    }
                DocumentEntry(path, kind, document.version, modelRef)
            }
        }

    @GetMapping("/document")
    @Throws(IOException::class)
    fun getDocument(
        @RequestParam path: String,
    ): ResponseEntity<DocumentView> {
        val kind = kindOf(path)
        val document = workspace.read(path)
        val content =
            when (val decoded = Documents.decode(kind, document.text, path)) {
                is DecodeResult.Ok -> decoded.value
                is DecodeResult.Failed -> throw Conflict(
                    ServerMessage.DOCUMENT_INVALID_STORED,
                    "Stored document '$path' is invalid",
                    decoded.diagnostics,
                    mapOf("path" to JsonPrimitive(path)),
                )
            }
        return ResponseEntity.ok().eTag(document.version).body(DocumentView(path, kind, document.version, content))
    }

    /** Downloads canonical document JSON as UTF-8 text; the ETag identifies the stored source version. */
    @GetMapping("/document/text", produces = ["text/plain;charset=UTF-8"])
    @Throws(IOException::class)
    fun getDocumentText(
        @RequestParam path: String,
    ): ResponseEntity<String> {
        val view = requireNotNull(getDocument(path).body)
        return ResponseEntity.ok().eTag(view.version).body(requireNotNull(Documents.encode(view.kind, view.content)))
    }

    @PutMapping("/document")
    @Throws(IOException::class)
    fun putDocument(
        @RequestParam path: String,
        @RequestHeader(HttpHeaders.IF_MATCH, required = false) ifMatch: String?,
        @RequestBody content: DocumentContent,
    ): ResponseEntity<DocumentEntry> {
        val kind = kindOf(path)
        val text =
            Documents.encode(kind, content)
                ?: throw BadRequest(
                    ServerMessage.DOCUMENT_KIND_CONTENT,
                    "Content must hold exactly one document of the kind of '$path'",
                    args = mapOf("path" to JsonPrimitive(path)),
                )
        val checked = Documents.decode(kind, text, path)
        if (checked is DecodeResult.Failed) {
            throw BadRequest(
                ServerMessage.DOCUMENT_INVALID_INPUT,
                "Document '$path' is invalid",
                checked.diagnostics,
                mapOf("path" to JsonPrimitive(path)),
            )
        }
        val version = if (ifMatch == null) workspace.create(path, text) else replace(path, text, ifMatch)
        return ResponseEntity.ok().eTag(version).body(DocumentEntry(path, kind, version, content.experiment?.modelRef))
    }

    @DeleteMapping("/document")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Throws(IOException::class)
    fun deleteDocument(
        @RequestParam path: String,
        @Parameter(required = true)
        @RequestHeader(HttpHeaders.IF_MATCH, required = false) ifMatch: String?,
    ): ResponseEntity<Void> {
        kindOf(path)
        if (ifMatch == null) {
            throw PreconditionRequired(
                ServerMessage.VERSION_REQUIRED_DELETE,
                "If-Match is required to delete '$path'",
                mapOf("path" to JsonPrimitive(path)),
            )
        }
        val current = workspace.read(path).version
        if (!IfMatch.accepts(ifMatch, current)) {
            throw Conflict(
                ServerMessage.VERSION_CONFLICT_MATCH,
                "Document '$path' is not at a version that If-Match accepts",
                args = mapOf("path" to JsonPrimitive(path)),
            )
        }
        workspace.delete(path, expectedVersion = current)
        return ResponseEntity.noContent().build()
    }

    @GetMapping("/changes")
    fun getWorkspaceChanges(
        @RequestParam(required = false) since: String?,
    ): WorkspaceChangesView {
        val cursor =
            try {
                since?.let(WorkspaceCursor::parse)
            } catch (_: IllegalArgumentException) {
                throw BadRequest(ServerMessage.CURSOR_INVALID, "Change cursor must have a valid generation and non-negative sequence")
            }
        val batch = workspace.changes(cursor)
        return WorkspaceChangesView(
            cursor = batch.cursor.toString(),
            reset = batch.reset,
            changes = batch.changes.map { WorkspaceChangeView(it.path, it.kind, it.version) },
        )
    }

    /** Writes over the stored document when [ifMatch] accepts its version; the write itself rechecks that version. */
    private fun replace(
        path: String,
        text: String,
        ifMatch: String,
    ): String {
        val current = if (workspace.exists(path)) workspace.read(path).version else null
        if (current == null || !IfMatch.accepts(ifMatch, current)) {
            throw Conflict(
                ServerMessage.VERSION_CONFLICT_MATCH,
                "Document '$path' is not at a version that If-Match accepts",
                args = mapOf("path" to JsonPrimitive(path)),
            )
        }
        return workspace.write(path, text, expectedVersion = current)
    }

    private fun kindOf(path: String): DocumentKind =
        DocumentKind.of(path) ?: throw BadRequest(
            ServerMessage.DOCUMENT_KIND_PATH,
            "'$path' is not a model, layout or experiment document",
            args = mapOf("path" to JsonPrimitive(path)),
        )
}
