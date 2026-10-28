package resiliencelab.core.lab

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.compiler.ModelLinter
import resiliencelab.core.compiler.Severity
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.engine.ksl.PathStreams
import resiliencelab.core.execution.CostEstimator
import resiliencelab.core.execution.ExperimentEstimate
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.execution.ExperimentTask
import resiliencelab.core.execution.checkCancellation
import resiliencelab.core.experiment.LatencySketch
import resiliencelab.core.results.ArtifactWriter
import resiliencelab.core.results.GridPoint
import resiliencelab.core.results.ResultsLayout
import resiliencelab.core.results.ResumeArtifact
import resiliencelab.core.results.RunManifest
import resiliencelab.core.results.RunSummary
import resiliencelab.core.results.SeriesMetadata
import resiliencelab.core.results.SeriesWriter
import resiliencelab.core.results.UnsupportedArtifactVersionException
import resiliencelab.core.results.Versions
import resiliencelab.core.results.uninterruptedArtifactWrite
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.InvalidDocumentPathException
import resiliencelab.core.workspace.VersionedDocument
import resiliencelab.core.workspace.Workspace
import java.io.IOException
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap

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
    fun validate(experimentPath: String): ValidationReport = validate(experimentPath, emptyMap())

    /**
     * Validates with in-memory document text at canonical workspace-relative paths, including new documents.
     * Drafts replace reads only; storage is never changed. Versions describe the text actually validated.
     * @throws InvalidDocumentPathException when a draft path is not canonical or leaves the workspace.
     */
    fun validate(
        experimentPath: String,
        drafts: Map<String, String>,
    ): ValidationReport {
        checkDraftPaths(drafts)
        val loaded = load(experimentPath, drafts)
        val warnings = loaded.experiment?.let { ModelLinter().lint(it) }.orEmpty()
        return ValidationReport(experimentPath, loaded.diagnostics + warnings, loaded.versions)
    }

    /** Estimates task, event, time, and storage costs from compiled IR without starting a model. */
    fun estimate(
        experimentPath: String,
        drafts: Map<String, String> = emptyMap(),
        workers: Int = ExperimentExecutor.defaultWorkers(),
    ): ExperimentEstimate {
        checkDraftPaths(drafts)
        val loaded = load(experimentPath, drafts)
        val compiled = loaded.experiment ?: throw InvalidExperimentException(loaded.diagnostics)
        return CostEstimator.estimate(compiled, workers)
    }

    private fun checkDraftPaths(drafts: Map<String, String>) {
        drafts.keys.forEach { path ->
            if (resolveRef("", path) != path) throw InvalidDocumentPathException(path)
            workspace.exists(path) // Enforce the storage boundary, including symbolic links, also for new drafts.
        }
    }

    /**
     * Runs a valid experiment and writes its reproducible result artifact under the workspace results directory.
     * [isCancelled] must be fast and thread-safe. Closed windows fill bounded parts; finished tasks are persisted immediately.
     * Cancellation keeps their files and publishes an incomplete manifest after active writers finish, without a
     * summary. Final summary/manifest publication finishes without further cancellation checks; caller interruptions
     * are restored afterwards. An already-cancelled call writes no files.
     * @throws CancellationException if cancellation is observed before final artifact publication.
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
        if (workspace.listFiles(runDirectory).isNotEmpty()) throw DocumentExistsException(runDirectory)
        val writer = ArtifactWriter(workspace)
        val series = seriesWriters(compiled, runDirectory)
        val manifest = newManifest(experimentPath, loaded.artifactVersions, compiled)
        try {
            executor.run(
                compiled,
                isCancelled = isCancelled,
                onWindow = { variant, point, replication, window, rows ->
                    series.getValue(ExperimentTask(variant, point, replication)).writeWindow(window, rows)
                },
                onReplication = { variant, point, replication, result ->
                    writer.writeReplication("$runDirectory/series/$variant/$point/rep-$replication", result)
                    series.getValue(ExperimentTask(variant, point, replication)).finish()
                },
                onProgress = onProgress,
            )
            checkCancellation(isCancelled)
            return uninterruptedArtifactWrite {
                val summary =
                    writer.summarize(
                        runDirectory,
                        experimentPath,
                        compiled.variants.map { it.id to it.label },
                        compiled.run.replications,
                        requireNotNull(manifest.series).points,
                        manifest.grid,
                    )
                RunOutcome(runDirectory, writer.write(runDirectory, manifest, summary), summary)
            }
        } catch (failure: Exception) {
            if (!workspace.exists("$runDirectory/manifest.json")) {
                try {
                    writer.write(runDirectory, manifest.copy(complete = false), null)
                } catch (writingFailure: Exception) {
                    failure.addSuppressed(writingFailure)
                }
            }
            throw failure
        }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private val artifactJson = Json { explicitNulls = false }

    /** Validates an incomplete run for resumption without changing its artifact or starting a model. */
    fun validateResume(runDirectory: String): RunManifest =
        withResumeLock(runDirectory) { prepareResume(runDirectory).manifest }

    /**
     * Resumes an incomplete artifact in place. Valid task files are preserved; missing or corrupt tasks are recomputed
     * with their original replication IDs. Document or version mismatches fail before any artifact mutation.
     */
    fun resume(
        runDirectory: String,
        isCancelled: () -> Boolean = { false },
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): RunOutcome =
        withResumeLock(runDirectory) {
            checkCancellation(isCancelled)
            val prepared = prepareResume(runDirectory)
            val manifest = prepared.manifest
            val compiled = prepared.compiled
            val tasks =
                compiled.variants.flatMap { variant ->
                    variant.points.flatMap { point ->
                        (0 until compiled.run.replications).map { replication ->
                            ExperimentTask(variant.id, point.id, replication)
                        }
                    }
                }
            val invalid = ResumeArtifact(workspace).prepare(runDirectory, manifest, tasks)
            val writer = ArtifactWriter(workspace)
            val series = seriesWriters(compiled, runDirectory)
            try {
                executor.runSelected(
                    compiled,
                    invalid,
                    isCancelled = isCancelled,
                    onWindow = { variant, point, replication, window, rows ->
                        series.getValue(ExperimentTask(variant, point, replication)).writeWindow(window, rows)
                    },
                    onReplication = { variant, point, replication, result ->
                        writer.writeReplication("$runDirectory/series/$variant/$point/rep-$replication", result)
                        series.getValue(ExperimentTask(variant, point, replication)).finish()
                    },
                    onProgress = onProgress,
                )
                checkCancellation(isCancelled)
                return@withResumeLock uninterruptedArtifactWrite {
                    val summary =
                        writer.summarize(
                            runDirectory,
                            manifest.experiment,
                            compiled.variants.map { it.id to it.label },
                            compiled.run.replications,
                            requireNotNull(manifest.series).points,
                            manifest.grid,
                        )
                    RunOutcome(runDirectory, writer.rewrite(runDirectory, manifest.copy(complete = true), summary), summary)
                }
            } catch (failure: Exception) {
                try {
                    writer.rewrite(runDirectory, manifest.copy(complete = false), null)
                } catch (writingFailure: Exception) {
                    failure.addSuppressed(writingFailure)
                }
                throw failure
            }
        }

    private class PreparedResume(
        val manifest: RunManifest,
        val compiled: CompiledExperiment,
    )

    private fun prepareResume(runDirectory: String): PreparedResume {
        val manifestPath = "$runDirectory/manifest.json"
        val manifest = artifactJson.decodeFromString(RunManifest.serializer(), workspace.read(manifestPath).text)
        if (manifest.schemaVersion != Versions.ARTIFACT_SCHEMA) {
            throw UnsupportedArtifactVersionException("manifest", manifest.schemaVersion)
        }
        if (manifest.complete) throw resumeFailure("RUN_COMPLETE", "Run is already complete", manifestPath)
        if (
            manifest.applicationVersion != Versions.APPLICATION ||
            manifest.kslVersion != Versions.KSL ||
            manifest.streamAssignment != PathStreams.ASSIGNMENT_VERSION
        ) {
            throw resumeFailure("RUN_INCOMPATIBLE", "Run versions changed; run again", manifestPath)
        }
        val canonical =
            runCatching { ResultsLayout.runDirectory(manifest.experiment, runDirectory.substringAfterLast('/')) }.getOrNull()
        if (canonical != runDirectory) {
            throw resumeFailure("RUN_INCOMPATIBLE", "Run directory does not match its manifest; run again", manifestPath)
        }
        val loaded = load(manifest.experiment)
        val compiled = loaded.experiment ?: throw InvalidExperimentException(loaded.diagnostics)
        if (loaded.artifactVersions != manifest.documents) {
            throw resumeFailure("RUN_DOCUMENT_CHANGED", "Run documents changed; run again", manifest.experiment)
        }
        val expected = newManifest(manifest.experiment, loaded.artifactVersions, compiled)
        if (
            manifest.seed != expected.seed ||
            manifest.replications != expected.replications ||
            manifest.variants != expected.variants ||
            manifest.grid != expected.grid ||
            manifest.series != expected.series
        ) {
            throw resumeFailure("RUN_INCOMPATIBLE", "Run metadata changed; run again", manifestPath)
        }
        return PreparedResume(manifest, compiled)
    }

    private fun resumeFailure(
        code: String,
        message: String,
        document: String,
    ) = InvalidExperimentException(listOf(Diagnostic(code, Severity.ERROR, message, document)))

    private fun seriesWriters(
        compiled: CompiledExperiment,
        runDirectory: String,
    ): Map<ExperimentTask, SeriesWriter> =
        compiled
            .variants
            .flatMap { variant ->
                variant.points.flatMap { point ->
                    (0 until compiled.run.replications).map { replication ->
                        ExperimentTask(variant.id, point.id, replication) to
                            SeriesWriter(
                                workspace,
                                "$runDirectory/series/${variant.id}/${point.id}/rep-$replication",
                                compiled.run.warmupMs + compiled.run.measurementMs,
                                compiled.run.windowMs,
                            )
                    }
                }
            }.toMap()

    private fun newManifest(
        experimentPath: String,
        documents: Map<String, String>,
        compiled: CompiledExperiment,
    ) = RunManifest(
        schemaVersion = Versions.ARTIFACT_SCHEMA,
        applicationVersion = Versions.APPLICATION,
        kslVersion = Versions.KSL,
        streamAssignment = PathStreams.ASSIGNMENT_VERSION,
        experiment = experimentPath,
        documents = documents,
        seed = compiled.run.seed,
        replications = compiled.run.replications,
        variants = compiled.variants.map { it.id },
        parts = emptyMap(),
        complete = true,
        grid = compiled.grid,
        series =
            SeriesMetadata(
                compiled.run.warmupMs,
                compiled.run.measurementMs,
                compiled.run.windowMs,
                LatencySketch.PROFILE,
                LatencySketch.LIBRARY_VERSION,
                "ms",
                "event-time",
                "measurement-arrival-cohort-including-run-out",
                compiled.variants
                    .first()
                    .points
                    .map { GridPoint(it.id, it.coordinates) },
            ),
    )

    private class Loaded(
        val experiment: CompiledExperiment?,
        val diagnostics: List<Diagnostic>,
        val versions: Map<String, String>,
        val artifactVersions: Map<String, String> = versions,
    )

    private fun load(
        experimentPath: String,
        drafts: Map<String, String> = emptyMap(),
    ): Loaded =
        try {
            loadDocuments(experimentPath, drafts)
        } catch (exception: UnreadableDocumentException) {
            failed(exception.diagnostic)
        }

    private fun loadDocuments(
        experimentPath: String,
        drafts: Map<String, String>,
    ): Loaded {
        val experimentDocument =
            read(experimentPath, drafts)
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
            modelPath?.let { read(it, drafts) }
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
        val layout = experiment.layoutRef?.let { checkLayout(experimentPath, it, drafts) }.orEmpty()
        val versions = sortedMapOf(experimentPath to experimentDocument.version, modelDocument.path to modelDocument.version)
        val artifactVersions =
            sortedMapOf(
                experimentPath to DocumentVersion.of(DocumentCodec.encodeExperiment(experiment)),
                modelDocument.path to DocumentVersion.of(DocumentCodec.encodeModel(model)),
            )
        return Loaded(result.experiment.takeIf { layout.isEmpty() }, result.diagnostics + layout, versions, artifactVersions)
    }

    /** The optional layout must be a readable layout document inside the workspace (ADR 0005, item 3). */
    private fun checkLayout(
        experimentPath: String,
        layoutRef: String,
        drafts: Map<String, String>,
    ): List<Diagnostic> {
        val layoutDocument =
            resolveRef(experimentPath, layoutRef)?.let { read(it, drafts) }
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
    private fun read(
        path: String,
        drafts: Map<String, String>,
    ): VersionedDocument? =
        try {
            val exists = workspace.exists(path)
            val draft = drafts[path]
            if (draft != null) {
                VersionedDocument(path, draft, DocumentVersion.of(draft))
            } else if (exists) {
                workspace.read(path)
            } else {
                null
            }
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
        private class ResumeMonitor {
            var users = 0
        }

        private val resumeMonitors = ConcurrentHashMap<String, ResumeMonitor>()

        /** Serializes one run across facade instances and removes the monitor after its last waiting caller leaves. */
        private fun <T> withResumeLock(
            runDirectory: String,
            action: () -> T,
        ): T {
            val monitor =
                synchronized(resumeMonitors) {
                    resumeMonitors.getOrPut(runDirectory) { ResumeMonitor() }.also { it.users++ }
                }
            try {
                synchronized(monitor) {
                    return action()
                }
            } finally {
                synchronized(resumeMonitors) {
                    monitor.users--
                    if (monitor.users == 0) resumeMonitors.remove(runDirectory, monitor)
                }
            }
        }

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
