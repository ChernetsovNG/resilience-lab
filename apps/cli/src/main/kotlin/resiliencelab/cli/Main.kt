package resiliencelab.cli

import kotlinx.serialization.json.Json
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.document.DocumentSchemas
import resiliencelab.core.execution.ExperimentEstimate
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.experiment.AggregateEntryMetrics
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.AggregateServiceMetrics
import resiliencelab.core.experiment.MetricSummary
import resiliencelab.core.experiment.ReplicaGroupKind
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunIds
import resiliencelab.core.lab.RunOutcome
import resiliencelab.core.results.ResultsLayout
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.results.RunSummary
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
    "Usage: validate <experiment.json> | estimate <experiment.json> | run [--workers N] [--replicas] <experiment.json> | " +
        "resume [--replicas] <run> | summary [--replicas] <run-id> | catalog | schema <model|layout|experiment>"

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
 * progress to [stderr] and the run directory followed by point summaries and service groups to [stdout]. `estimate` prints
 * core JSON; `catalog` and `schema` print core-generated JSON without opening the workspace.
 * `summary` reads a finished run by ID; `--replicas` expands service groups in the shared summary output.
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
        if (command.kind == CommandKind.RESUME || command.kind == CommandKind.SUMMARY) {
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
            CommandKind.RUN -> run(lab, argument, newRunId(), root, stdout, stderr, isCancelled, execute, command.replicas)
            CommandKind.RESUME -> resume(lab, workspace, argument, root, stdout, stderr, isCancelled, command.replicas)
            CommandKind.SUMMARY -> summary(workspace, argument, stdout, stderr, command.replicas)
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
    SUMMARY,
}

private class Command(
    val kind: CommandKind,
    val argument: String,
    val workers: Int?,
    val replicas: Boolean = false,
) {
    companion object {
        fun parse(args: List<String>): Command? {
            val replicaFlags = args.count { it == "--replicas" }
            if (replicaFlags > 1 || replicaFlags == 1 && args.firstOrNull() !in listOf("run", "resume", "summary")) return null
            val arguments = args.filterNot { it == "--replicas" }
            val replicas = replicaFlags == 1
            return when {
                arguments.size == 2 && arguments[0] == "validate" -> Command(CommandKind.VALIDATE, arguments[1], null)
                arguments.size == 2 && arguments[0] == "estimate" -> Command(CommandKind.ESTIMATE, arguments[1], null)
                arguments.size == 2 && arguments[0] == "run" -> Command(CommandKind.RUN, arguments[1], null, replicas)
                arguments.size == 2 && arguments[0] == "resume" -> Command(CommandKind.RESUME, arguments[1], null, replicas)
                arguments.size == 2 && arguments[0] == "summary" -> Command(CommandKind.SUMMARY, arguments[1], null, replicas)
                arguments.size == 4 && arguments[0] == "run" && arguments[1] == "--workers" ->
                    arguments[2].toIntOrNull()?.takeIf { it >= 1 }?.let { Command(CommandKind.RUN, arguments[3], it, replicas) }
                else -> null
            }
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
    report.diagnostics.sortedBy { it.severity.ordinal }.forEach {
        stderr.appendLine("- ${location(it)}: ${it.severity}: ${it.code}: ${it.message}")
    }
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
    replicas: Boolean,
): Int {
    val outcome =
        try {
            execute(lab, experiment, runId, isCancelled) { completed, total ->
                synchronized(stderr) { stderr.appendLine("Tasks $completed/$total") }
            }
        } catch (error: CancellationException) {
            return cancellation(workspaceRoot, ResultsLayout.runDirectory(lab.canonicalPath(experiment), runId), stderr)
        } catch (error: InvalidExperimentException) {
            return validationError(stderr, error.diagnostics)
        } catch (error: Exception) {
            stderr.appendLine("Execution failed: ${firstLine(error)}")
            return 1
        }
    printSummary(outcome.runDirectory, outcome.summary, stdout, replicas)
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
    replicas: Boolean,
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
    printSummary(outcome.runDirectory, outcome.summary, stdout, replicas)
    return 0
}

private fun summary(
    workspace: FileWorkspace,
    runId: String,
    stdout: Appendable,
    stderr: Appendable,
    replicas: Boolean,
): Int {
    try {
        val catalog = RunCatalog(workspace)
        val entry = catalog.entry(runId) ?: return inputError(stderr, "Run not found: $runId")
        val summary = catalog.summary(runId) ?: return inputError(stderr, "Run not found: $runId")
        printSummary(entry.directory, summary, stdout, replicas)
    } catch (error: Exception) {
        return inputError(stderr, "Cannot read summary: ${firstLine(error)}")
    }
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

private fun printSummary(
    runDirectory: String,
    summary: RunSummary,
    stdout: Appendable,
    replicas: Boolean,
) {
    stdout.appendLine(runDirectory)
    summary.variants.forEach { variant ->
        variant.points.forEach { point ->
            val aggregate = point.aggregate
            val coordinates = point.coordinates.entries.joinToString(", ") { (path, value) -> "$path=$value" }
            val suffix = if (coordinates.isEmpty()) "" else " [$coordinates]"
            stdout.append("${variant.id}/${point.id}$suffix: entry total: ${entryMetrics(aggregate.entries.total)}; ")
            val saturation = point.saturation
            saturation.firstNodes.forEach { first ->
                stdout.append(
                    "first saturation: ${first.label.message} (${first.node}/${first.slotPool}) " +
                        "in ${first.replicationCount} of ${variant.replications} replications, " +
                        String.format(
                            Locale.ROOT,
                            "median start %.1f ms, range %.1f–%.1f ms; ",
                            first.medianStartMs,
                            first.minStartMs,
                            first.maxStartMs,
                        ),
                )
            }
            stdout.append("without saturation: ${saturation.withoutSaturation} of ${variant.replications} replications")
            if (saturation.withoutSaturation == variant.replications) {
                stdout.append(
                    "; capacity headroom (pooled over measurement): utilization ${headroom(point.headroom.utilization, true)}, " +
                        "mean queue ${headroom(point.headroom.meanQueueLength, false)}",
                )
            }
            stdout.appendLine()
            listOf("client" to aggregate.entries.clients, "class" to aggregate.entries.classes).forEach { (kind, entries) ->
                if (entries.size > 1) {
                    entries.toSortedMap().forEach { (id, metrics) ->
                        stdout.appendLine("  entry $kind $id: ${entryMetrics(metrics)}")
                    }
                }
            }
            printGroups(aggregate, stdout, replicas)
        }
    }
}

private fun entryMetrics(metrics: AggregateEntryMetrics): String {
    val failures =
        metrics.failuresByReason.entries
            .sortedWith(compareByDescending<Map.Entry<String, MetricSummary>> { it.value.mean }.thenBy { it.key })
            .take(3)
            .joinToString(", ") { (reason, rate) -> "$reason ${percent(rate)}" }
    val values =
        "success ${percent(metrics.successRate)}, p95 ${millis(metrics.p95LatencyMs)}, p99 ${millis(metrics.p99LatencyMs)}"
    return if (failures.isEmpty()) values else "$values; failure reasons $failures"
}

private fun printGroups(
    aggregate: AggregateMetrics,
    stdout: Appendable,
    replicas: Boolean,
) {
    val groups = aggregate.groups.filter { it.kind == ReplicaGroupKind.NODE }
    if (groups.isEmpty()) return
    val groupedIds = groups.flatMap { group -> listOf(group.id) + group.instances.map { it.id } }.toSet()
    aggregate.services.filterKeys { it !in groupedIds }.forEach { (id, metrics) ->
        stdout.appendLine("  service $id: ${serviceMetrics(metrics)}")
    }
    groups.forEach { group ->
        val metrics = aggregate.services.getValue(group.id)
        val extrema = metrics.totals.slotPools["handlers"]?.replicaExtrema
        val worst = group.instances.find { it.replica == extrema?.maxUtilizationReplica }?.id ?: "n/a"
        stdout.appendLine(
            "  group ${group.id}: ${serviceMetrics(metrics)}, p99 ${format(metrics.pooledLatency?.p99Ms, "%.1f ms")}; " +
                "worst replica $worst: " +
                "utilization ${format(extrema?.maxUtilization?.times(100), "%.1f%%")}",
        )
        if (replicas) {
            group.instances.sortedBy { it.replica }.forEach { member ->
                stdout.appendLine("    replica ${member.id}: ${serviceMetrics(aggregate.services.getValue(member.id))}")
            }
        }
    }
}

private fun serviceMetrics(metrics: AggregateServiceMetrics): String {
    val handlers = metrics.slotPoolSummaries["handlers"]
    val totals = metrics.totals
    val pool = totals.slotPools["handlers"]
    val utilization =
        handlers?.utilization?.mean
            ?: pool?.takeIf { it.capacityIntegralMs > 0 }?.let { it.busyIntegralMs / it.capacityIntegralMs }
    val meanQueue =
        handlers?.meanQueueLength?.mean
            ?: pool?.takeIf { totals.measurementMs > 0 }?.let { it.queueIntegralMs / totals.measurementMs }
    return "utilization ${format(utilization?.times(100), "%.1f%%")}, mean queue ${format(meanQueue)}, failures ${totals.failures}"
}

private fun format(
    value: Double?,
    pattern: String = "%.2f",
): String = value?.let { String.format(Locale.ROOT, pattern, it) } ?: "n/a"

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
