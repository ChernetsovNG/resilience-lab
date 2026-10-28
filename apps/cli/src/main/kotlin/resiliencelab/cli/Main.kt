package resiliencelab.cli

import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.experiment.MetricSummary
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunIds
import resiliencelab.core.lab.RunOutcome
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.util.Locale
import kotlin.system.exitProcess

private const val USAGE = "Usage: validate <experiment.json> | run [--workers N] <experiment.json>"

/** Runs one command against the current directory as the workspace and exits with its status. */
fun main(args: Array<String>) {
    exitProcess(runCommand(args.asList(), System.out, System.err))
}

/** Runs an experiment through [Lab]: the CLI counterpart of `POST /jobs`. */
internal typealias ExperimentRun = (lab: Lab, experiment: String, runId: String, onProgress: (Int, Int) -> Unit) -> RunOutcome

/**
 * Validates or runs an experiment of the workspace at [workspaceRoot] (stage 1 design §5.3). Returns 0 on success,
 * 2 for usage errors and invalid experiments, 1 for execution failures. `run` writes the artifact to `.results/`,
 * progress to [stderr], and the run directory followed by one summary line per variant to [stdout].
 */
internal fun runCommand(
    args: List<String>,
    stdout: Appendable,
    stderr: Appendable,
    workspaceRoot: Path = Path.of("").toAbsolutePath(),
    newRunId: () -> String = { RunIds.next() },
    execute: ExperimentRun = { lab, experiment, runId, onProgress -> lab.run(experiment, runId, onProgress = onProgress) },
): Int {
    val command = Command.parse(args) ?: return usage(stderr)
    val root = workspaceRoot.toAbsolutePath().normalize()
    val experiment =
        relativePath(root, command.experiment)
            ?: return inputError(stderr, "experiment must be inside the workspace $root: ${command.experiment}")
    val executor = command.workers?.let { ExperimentExecutor(it) } ?: ExperimentExecutor()
    return executor.use {
        val lab = Lab(FileWorkspace(root), executor = executor)
        if (command.run) {
            run(lab, experiment, newRunId(), stdout, stderr, execute)
        } else {
            validate(lab, experiment, stderr)
        }
    }
}

private class Command(
    val run: Boolean,
    val experiment: String,
    val workers: Int?,
) {
    companion object {
        fun parse(args: List<String>): Command? =
            when {
                args.size == 2 && args[0] == "validate" -> Command(run = false, experiment = args[1], workers = null)
                args.size == 2 && args[0] == "run" -> Command(run = true, experiment = args[1], workers = null)
                args.size == 4 && args[0] == "run" && args[1] == "--workers" ->
                    args[2].toIntOrNull()?.takeIf { it >= 1 }?.let { Command(run = true, experiment = args[3], workers = it) }
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

private fun run(
    lab: Lab,
    experiment: String,
    runId: String,
    stdout: Appendable,
    stderr: Appendable,
    execute: ExperimentRun,
): Int {
    val outcome =
        try {
            execute(lab, experiment, runId) { completed, total ->
                synchronized(stderr) { stderr.appendLine("Tasks $completed/$total") }
            }
        } catch (error: InvalidExperimentException) {
            return validationError(stderr, error.diagnostics)
        } catch (error: Exception) {
            stderr.appendLine("Execution failed: ${firstLine(error)}")
            return 1
        }
    stdout.appendLine(outcome.runDirectory)
    outcome.summary.variants.forEach { variant ->
        variant.points.forEach { point ->
            val aggregate = point.aggregate
            val coordinates = point.coordinates.entries.joinToString(", ") { (path, value) -> "$path=$value" }
            val suffix = if (coordinates.isEmpty()) "" else " [$coordinates]"
            stdout.appendLine(
                "${variant.id}/${point.id}$suffix: success ${percent(aggregate.successRate)}, " +
                    "p95 ${millis(aggregate.p95LatencyMs)}, p99 ${millis(aggregate.p99LatencyMs)}",
            )
        }
    }
    return 0
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
