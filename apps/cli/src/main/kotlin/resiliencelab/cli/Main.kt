package resiliencelab.cli

import kotlinx.serialization.json.Json
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.document.DocumentSchemas
import resiliencelab.core.execution.ExperimentEstimate
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.experiment.MetricSummary
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunIds
import resiliencelab.core.lab.RunOutcome
import resiliencelab.core.results.ResultsLayout
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.results.SlotPoolPeak
import resiliencelab.core.workspace.DocumentNotFoundException
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.util.Locale
import java.util.concurrent.CancellationException
import kotlin.system.exitProcess

private const val USAGE =
    "Usage: validate <experiment.json> | estimate <experiment.json> | run [--workers N] <experiment.json> | " +
        "resume <run> | catalog | schema <model|layout|experiment>"

private val apiJson = Json { encodeDefaults = true }
private val documentKinds = setOf("model", "layout", "experiment")

/** Runs one command against the current directory as the workspace and exits with its status. */
fun main(args: Array<String>) {
    val status =
        if (args.firstOrNull() == "run" || args.firstOrNull() == "resume") {
            SignalCancellation().use { cancellation ->
                runCommand(args.asList(), System.out, System.err, isCancelled = cancellation::isCancelled)
            }
        } else {
            runCommand(args.asList(), System.out, System.err)
        }
    exitProcess(status)
}

/** Runs an experiment through [Lab]: the CLI counterpart of `POST /jobs`. */
internal typealias ExperimentRun = (
    lab: Lab,
    experiment: String,
    runId: String,
    isCancelled: () -> Boolean,
    onProgress: (Int, Int) -> Unit,
) -> RunOutcome

/**
 * Executes one CLI command against the workspace at [workspaceRoot] (stage 1 design §5.3). Returns 0 on success,
 * 2 for usage errors and invalid experiments, 1 for execution failures, 130 for cancellation. `run` and `resume` write
 * progress to [stderr] and the run directory followed by one summary line per variant to [stdout]. `estimate` prints
 * core JSON; `catalog` and `schema` print core-generated JSON without opening the workspace.
 */
internal fun runCommand(
    args: List<String>,
    stdout: Appendable,
    stderr: Appendable,
    workspaceRoot: Path = Path.of("").toAbsolutePath(),
    newRunId: () -> String = { RunIds.next() },
    isCancelled: () -> Boolean = { false },
    execute: ExperimentRun = { lab, experiment, runId, cancelled, onProgress ->
        lab.run(experiment, runId, isCancelled = cancelled, onProgress = onProgress)
    },
): Int {
    when {
        args == listOf("catalog") -> return printCatalog(stdout)
        args.size == 2 && args[0] == "schema" && args[1] in documentKinds -> return printSchema(args[1], stdout)
    }
    val command = Command.parse(args) ?: return usage(stderr)
    val root = workspaceRoot.toAbsolutePath().normalize()
    val argument =
        if (command.kind == CommandKind.RESUME) {
            command.argument
        } else {
            relativePath(root, command.argument)
                ?: return inputError(stderr, "experiment must be inside the workspace $root: ${command.argument}")
        }
    val executor = command.workers?.let { ExperimentExecutor(it) } ?: ExperimentExecutor()
    return executor.use {
        val workspace = FileWorkspace(root)
        val lab = Lab(workspace, executor = executor)
        when (command.kind) {
            CommandKind.VALIDATE -> validate(lab, argument, stderr)
            CommandKind.ESTIMATE -> estimate(lab, argument, stdout, stderr)
            CommandKind.RUN -> run(lab, argument, newRunId(), root, stdout, stderr, isCancelled, execute)
            CommandKind.RESUME -> resume(lab, workspace, argument, root, stdout, stderr, isCancelled)
        }
    }
}

private fun printCatalog(stdout: Appendable): Int {
    stdout.appendLine(apiJson.encodeToString(Catalog.serializer(), Stage1Catalog.catalog))
    return 0
}

private fun printSchema(
    kind: String,
    stdout: Appendable,
): Int {
    stdout.append(DocumentSchemas().generate().getValue("$kind.schema.json"))
    return 0
}

private enum class CommandKind {
    VALIDATE,
    ESTIMATE,
    RUN,
    RESUME,
}

private class Command(
    val kind: CommandKind,
    val argument: String,
    val workers: Int?,
) {
    companion object {
        fun parse(args: List<String>): Command? =
            when {
                args.size == 2 && args[0] == "validate" -> Command(CommandKind.VALIDATE, args[1], null)
                args.size == 2 && args[0] == "estimate" -> Command(CommandKind.ESTIMATE, args[1], null)
                args.size == 2 && args[0] == "run" -> Command(CommandKind.RUN, args[1], null)
                args.size == 2 && args[0] == "resume" -> Command(CommandKind.RESUME, args[1], null)
                args.size == 4 && args[0] == "run" && args[1] == "--workers" ->
                    args[2].toIntOrNull()?.takeIf { it >= 1 }?.let { Command(CommandKind.RUN, args[3], it) }
                else -> null
            }
    }
}

private fun validate(
    lab: Lab,
    experiment: String,
    stderr: Appendable,
): Int {
    val report = lab.validate(experiment)
    if (!report.valid) return validationError(stderr, report.diagnostics)
    report.diagnostics.forEach { stderr.appendLine("- ${location(it)}: ${it.severity}: ${it.code}: ${it.message}") }
    stderr.appendLine("Valid experiment: $experiment")
    return 0
}

private fun estimate(
    lab: Lab,
    experiment: String,
    stdout: Appendable,
    stderr: Appendable,
): Int =
    try {
        val result = lab.estimate(experiment)
        stdout.appendLine(apiJson.encodeToString(ExperimentEstimate.serializer(), result))
        0
    } catch (error: InvalidExperimentException) {
        validationError(stderr, error.diagnostics)
    } catch (error: Exception) {
        stderr.appendLine("Execution failed: ${firstLine(error)}")
        1
    }

private fun run(
    lab: Lab,
    experiment: String,
    runId: String,
    workspaceRoot: Path,
    stdout: Appendable,
    stderr: Appendable,
    isCancelled: () -> Boolean,
    execute: ExperimentRun,
): Int {
    val outcome =
        try {
            execute(lab, experiment, runId, isCancelled) { completed, total ->
                synchronized(stderr) { stderr.appendLine("Tasks $completed/$total") }
            }
        } catch (error: CancellationException) {
            return cancellation(workspaceRoot, ResultsLayout.runDirectory(experiment, runId), stderr)
        } catch (error: InvalidExperimentException) {
            return validationError(stderr, error.diagnostics)
        } catch (error: Exception) {
            stderr.appendLine("Execution failed: ${firstLine(error)}")
            return 1
        }
    printOutcome(outcome, stdout)
    return 0
}

private fun resume(
    lab: Lab,
    workspace: FileWorkspace,
    argument: String,
    workspaceRoot: Path,
    stdout: Appendable,
    stderr: Appendable,
    isCancelled: () -> Boolean,
): Int {
    val entry = RunCatalog(workspace).entry(argument)
    val directory =
        when {
            entry != null -> entry.directory
            !argument.contains('/') && !argument.contains('\\') -> return inputError(stderr, "Run not found: $argument")
            else ->
                relativePath(workspaceRoot, argument)
                    ?: return inputError(stderr, "run must be inside the workspace $workspaceRoot: $argument")
        }
    val outcome =
        try {
            lab.resume(directory, isCancelled) { completed, total ->
                synchronized(stderr) { stderr.appendLine("Tasks $completed/$total") }
            }
        } catch (error: CancellationException) {
            return cancellation(workspaceRoot, directory, stderr)
        } catch (error: InvalidExperimentException) {
            return validationError(stderr, error.diagnostics)
        } catch (_: DocumentNotFoundException) {
            return inputError(stderr, "Run not found: $argument")
        } catch (error: Exception) {
            stderr.appendLine("Execution failed: ${firstLine(error)}")
            return 1
        }
    printOutcome(outcome, stdout)
    return 0
}

private fun cancellation(
    workspaceRoot: Path,
    directory: String,
    stderr: Appendable,
): Int {
    stderr.appendLine(
        if (Files.isRegularFile(workspaceRoot.resolve("$directory/manifest.json"))) {
            "Cancelled: $directory"
        } else {
            "Cancelled before an artifact was created"
        },
    )
    return 130
}

private fun printOutcome(
    outcome: RunOutcome,
    stdout: Appendable,
) {
    stdout.appendLine(outcome.runDirectory)
    outcome.summary.variants.forEach { variant ->
        variant.points.forEach { point ->
            val aggregate = point.aggregate
            val coordinates = point.coordinates.entries.joinToString(", ") { (path, value) -> "$path=$value" }
            val suffix = if (coordinates.isEmpty()) "" else " [$coordinates]"
            stdout.appendLine(
                "${variant.id}/${point.id}$suffix: success ${percent(aggregate.successRate)}, " +
                    "p95 ${millis(aggregate.p95LatencyMs)}, p99 ${millis(aggregate.p99LatencyMs)}; " +
                    "capacity headroom: utilization ${headroom(point.headroom.utilization, true)}, " +
                    "mean queue ${headroom(point.headroom.meanQueueLength, false)}",
            )
        }
    }
}

private fun headroom(
    peak: SlotPoolPeak?,
    utilization: Boolean,
): String =
    if (peak == null) {
        "n/a"
    } else {
        val value =
            if (utilization) {
                "${String.format(Locale.ROOT, "%.2f", peak.value * 100)}%"
            } else {
                String.format(Locale.ROOT, "%.2f", peak.value)
            }
        "$value at ${peak.label.message}"
    }

private fun relativePath(
    root: Path,
    argument: String,
): String? {
    val resolved =
        try {
            root.resolve(argument).normalize()
        } catch (exception: InvalidPathException) {
            return null
        }
    if (!resolved.startsWith(root) || resolved == root) return null
    return root.relativize(resolved).joinToString("/")
}

private fun usage(stderr: Appendable): Int {
    stderr.appendLine(USAGE)
    return 2
}

private fun inputError(
    stderr: Appendable,
    message: String,
): Int {
    stderr.appendLine("Invalid input: $message")
    return 2
}

private fun validationError(
    stderr: Appendable,
    diagnostics: List<Diagnostic>,
): Int {
    stderr.appendLine("Validation failed:")
    diagnostics.forEach { stderr.appendLine("- ${location(it)}: ${it.code}: ${it.message}") }
    return 2
}

private fun location(diagnostic: Diagnostic): String {
    val location = listOfNotNull(diagnostic.document, diagnostic.pointer).joinToString("#").ifEmpty { "experiment" }
    return diagnostic.variant?.let { "$it · $location" } ?: location
}

private fun percent(summary: MetricSummary?): String = summary?.let { String.format(Locale.ROOT, "%.1f%%", it.mean * 100) } ?: "n/a"

private fun millis(summary: MetricSummary?): String = summary?.let { String.format(Locale.ROOT, "%.1f ms", it.mean) } ?: "n/a"

private fun firstLine(error: Throwable): String =
    error.message
        ?.lineSequence()
        ?.firstOrNull()
        ?.takeIf { it.isNotBlank() }
        ?: error.javaClass.simpleName
