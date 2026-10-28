package resiliencelab.core.lab

import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.compiler.ModelLinter
import resiliencelab.core.compiler.Severity
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.execution.checkCancellation
import resiliencelab.core.results.ArtifactWriter
import resiliencelab.core.results.ResultsLayout
import resiliencelab.core.results.RunManifest
import resiliencelab.core.results.RunSummary
import resiliencelab.core.results.VariantSummary
import resiliencelab.core.results.Versions
import resiliencelab.core.workspace.InvalidDocumentPathException
import resiliencelab.core.workspace.VersionedDocument
import resiliencelab.core.workspace.Workspace
import java.io.IOException
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask

/** Diagnostics and versions of the computation inputs of one experiment. */
data class ValidationReport(
    val experimentPath: String,
    val diagnostics: List<Diagnostic>,
    val documentVersions: Map<String, String> = emptyMap(),
) {
    val valid: Boolean get() = diagnostics.none { it.severity == Severity.ERROR }
}

/** Location and contents of a finished run. */
data class RunOutcome(
    val runDirectory: String,
    val manifest: RunManifest,
    val summary: RunSummary,
)

class InvalidExperimentException(
    val diagnostics: List<Diagnostic>,
) : RuntimeException(
        "Experiment has errors: " + diagnostics.filter { it.severity == Severity.ERROR }.joinToString("; ") { it.message },
    )

/**
 * Entry point for the server and the CLI: validates and runs workspace experiments (stage 1 design §4–5).
 * The default executor is owned by this facade; an injected executor remains caller-owned.
 */
class Lab(
    private val workspace: Workspace,
    private val compiler: ModelCompiler = ModelCompiler(),
    executor: ExperimentExecutor? = null,
) : AutoCloseable {
    private val ownsExecutor = executor == null
    private val executor = executor ?: ExperimentExecutor()

    /** Closes the default-owned executor. An injected executor remains open for its caller to reuse or close. */
    override fun close() {
        if (ownsExecutor) executor.close()
    }

    /** Validates an experiment and all referenced documents in the workspace. */
    fun validate(experimentPath: String): ValidationReport {
        val loaded = load(experimentPath)
        val warnings = loaded.experiment?.let { ModelLinter().lint(it) }.orEmpty()
        return ValidationReport(experimentPath, loaded.diagnostics + warnings, loaded.versions)
    }

    /**
     * Runs a valid experiment and writes its reproducible result artifact under the workspace results directory.
     * [isCancelled] must be fast and thread-safe. Cancellation is accepted until artifact writing starts;
     * a cancelled run writes no files. Once writing starts, it finishes without further cancellation checks.
     * Caller interruptions during writing are restored after the write, without interrupting file I/O.
     * @throws CancellationException if cancellation is observed before writing the artifact.
     */
    fun run(
        experimentPath: String,
        runId: String,
        isCancelled: () -> Boolean = { false },
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): RunOutcome = run(experimentPath, runId, expectedVersions = null, isCancelled = isCancelled, onProgress = onProgress)

    /**
     * Runs only the computation inputs accepted by validation when [expectedVersions] is supplied. The check uses
     * the same loaded documents as compilation and execution, so a queued job cannot silently run later edits.
     * A mismatch raises [InvalidExperimentException] with `DOCUMENT_CHANGED` before computing or writing results.
     * [isCancelled] has the same contract as the overload without [expectedVersions].
     * @throws CancellationException if cancellation is observed before writing the artifact.
     */
    fun run(
        experimentPath: String,
        runId: String,
        expectedVersions: Map<String, String>?,
        isCancelled: () -> Boolean = { false },
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): RunOutcome {
        checkCancellation(isCancelled)
        val runDirectory = ResultsLayout.runDirectory(experimentPath, runId)
        val loaded = load(experimentPath)
        val compiled = loaded.experiment ?: throw InvalidExperimentException(loaded.diagnostics)
        if (expectedVersions != null && expectedVersions != loaded.versions) {
            throw InvalidExperimentException(
                listOf(
                    Diagnostic(
                        "DOCUMENT_CHANGED",
                        Severity.ERROR,
                        "Experiment documents changed after validation; submit the experiment again",
                        experimentPath,
                    ),
                ),
            )
        }
        val result = executor.run(compiled, isCancelled = isCancelled, onProgress = onProgress)
        val summary =
            RunSummary(
                schemaVersion = 1,
                experiment = experimentPath,
                variants = result.variants.map { VariantSummary(it.id, it.label, it.replications.size, it.aggregate) },
            )
        val manifest =
            RunManifest(
                schemaVersion = 1,
                applicationVersion = Versions.APPLICATION,
                kslVersion = Versions.KSL,
                streamAssignment = PathStreams.ASSIGNMENT_VERSION,
                experiment = experimentPath,
                documents = loaded.versions,
                seed = compiled.run.seed,
                replications = compiled.run.replications,
                variants = compiled.variants.map { it.id },
                parts = emptyMap(),
                complete = true,
            )
        checkCancellation(isCancelled)
        return RunOutcome(runDirectory, writeArtifact(runDirectory, manifest, summary), summary)
    }

    /** After the final cancellation check, keep caller interruptions away from interruptible workspace file I/O. */
    private fun writeArtifact(
        runDirectory: String,
        manifest: RunManifest,
        summary: RunSummary,
    ): RunManifest {
        val write = FutureTask { ArtifactWriter(workspace).write(runDirectory, manifest, summary) }
        Thread.ofVirtual().name("artifact-write").start(write)
        var interrupted = false
        try {
            while (true) {
                try {
                    return write.get()
                } catch (_: InterruptedException) {
                    interrupted = true
                } catch (exception: ExecutionException) {
                    throw exception.cause ?: exception
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt()
        }
    }

    private class Loaded(
        val experiment: CompiledExperiment?,
        val diagnostics: List<Diagnostic>,
        val versions: Map<String, String>,
    )

    private fun load(experimentPath: String): Loaded =
        try {
            loadDocuments(experimentPath)
        } catch (exception: UnreadableDocumentException) {
            failed(exception.diagnostic)
        }

    private fun loadDocuments(experimentPath: String): Loaded {
        val experimentDocument =
            read(experimentPath)
                ?: return failed(
                    Diagnostic("DOCUMENT_MISSING", Severity.ERROR, "Document '$experimentPath' does not exist", experimentPath),
                )
        val experiment =
            when (val decoded = DocumentCodec.decodeExperiment(experimentDocument.text, experimentPath)) {
                is DecodeResult.Ok -> decoded.value
                is DecodeResult.Failed -> return Loaded(null, decoded.diagnostics, emptyMap())
            }
        val modelPath = resolveRef(experimentPath, experiment.modelRef)
        val modelDocument =
            modelPath?.let(::read)
                ?: return failed(
                    Diagnostic(
                        "MODEL_REF",
                        Severity.ERROR,
                        "modelRef '${experiment.modelRef}' does not name a model in the workspace",
                        experimentPath,
                        "/modelRef",
                    ),
                )
        val model =
            when (val decoded = DocumentCodec.decodeModel(modelDocument.text, modelDocument.path)) {
                is DecodeResult.Ok -> decoded.value
                is DecodeResult.Failed -> return Loaded(null, decoded.diagnostics, emptyMap())
            }
        val result = compiler.compile(model, modelDocument.path, experiment, experimentPath)
        val layout = experiment.layoutRef?.let { checkLayout(experimentPath, it) }.orEmpty()
        val versions = sortedMapOf(experimentPath to experimentDocument.version, modelDocument.path to modelDocument.version)
        return Loaded(result.experiment.takeIf { layout.isEmpty() }, result.diagnostics + layout, versions)
    }

    /** The optional layout must be a readable layout document inside the workspace (ADR 0005, item 3). */
    private fun checkLayout(
        experimentPath: String,
        layoutRef: String,
    ): List<Diagnostic> {
        val layoutDocument =
            resolveRef(experimentPath, layoutRef)?.let(::read)
                ?: return listOf(
                    Diagnostic(
                        "LAYOUT_REF",
                        Severity.ERROR,
                        "layoutRef '$layoutRef' does not name a layout in the workspace",
                        experimentPath,
                        "/layoutRef",
                    ),
                )
        return when (val decoded = DocumentCodec.decodeLayout(layoutDocument.text, layoutDocument.path)) {
            is DecodeResult.Ok -> emptyList()
            is DecodeResult.Failed -> decoded.diagnostics
        }
    }

    /** The document, or null when it does not exist or its path is invalid; a failed read is a diagnostic, not a crash. */
    private fun read(path: String): VersionedDocument? =
        try {
            if (workspace.exists(path)) workspace.read(path) else null
        } catch (exception: InvalidDocumentPathException) {
            null
        } catch (exception: IOException) {
            val reason = exception.message ?: exception.javaClass.simpleName
            val diagnostic = Diagnostic("DOCUMENT_UNREADABLE", Severity.ERROR, "Document '$path' cannot be read: $reason", path)
            throw UnreadableDocumentException(diagnostic)
        }

    private fun failed(diagnostic: Diagnostic) = Loaded(null, listOf(diagnostic), emptyMap())

    private class UnreadableDocumentException(
        val diagnostic: Diagnostic,
    ) : RuntimeException(diagnostic.message)

    companion object {
        /** Resolves [ref] against the directory of [documentPath]; null when it leaves the workspace or is not relative. */
        fun resolveRef(
            documentPath: String,
            ref: String,
        ): String? {
            if (ref.startsWith("/") || ref.contains('\\') || ref.contains("://")) return null
            val base = documentPath.substringBeforeLast('/', "")
            val segments = ArrayDeque<String>()
            val joined = if (base.isEmpty()) ref else "$base/$ref"
            for (segment in joined.split('/')) {
                when (segment) {
                    "", "." -> Unit
                    ".." -> if (segments.isEmpty()) return null else segments.removeLast()
                    else -> segments.addLast(segment)
                }
            }
            return segments.joinToString("/").ifEmpty { null }
        }
    }
}
