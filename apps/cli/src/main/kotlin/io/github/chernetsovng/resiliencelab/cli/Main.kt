package io.github.chernetsovng.resiliencelab.cli

import io.github.chernetsovng.resiliencelab.core.experiment.ExperimentResult
import io.github.chernetsovng.resiliencelab.core.experiment.ExperimentRunner
import io.github.chernetsovng.resiliencelab.core.experiment.SweepExpander
import io.github.chernetsovng.resiliencelab.core.scenario.ExperimentDocument
import io.github.chernetsovng.resiliencelab.core.scenario.ScenarioCodec
import io.github.chernetsovng.resiliencelab.core.scenario.ScenarioValidationException
import io.github.chernetsovng.resiliencelab.core.scenario.ScenarioValidator
import io.github.chernetsovng.resiliencelab.core.scenario.ValidationIssue
import kotlinx.serialization.json.Json
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.system.exitProcess

private const val USAGE =
    "Usage: validate <experiment.json> | run <experiment.json> | sweep <sweep.json>"

fun main(args: Array<String>) {
    exitProcess(runCommand(args.asList(), System.out, System.err))
}

internal fun runCommand(
    args: List<String>,
    stdout: Appendable,
    stderr: Appendable,
    experimentRunner: (ExperimentDocument) -> ExperimentResult = ExperimentRunner::run,
): Int {
    if (args.size != 2 || args[0] !in setOf("validate", "run", "sweep")) {
        stderr.appendLine(USAGE)
        return 2
    }

    val text = try {
        Path.of(args[1]).readText()
    } catch (error: Exception) {
        return inputError(stderr, error)
    }

    return when (args[0]) {
        "validate" -> validate(text, args[1], stderr)
        "run" -> run(text, stdout, stderr, experimentRunner)
        else -> sweep(text, stdout, stderr, experimentRunner)
    }
}

private fun validate(text: String, path: String, stderr: Appendable): Int {
    val document = try {
        ScenarioCodec.decodeExperiment(text)
    } catch (error: Exception) {
        return inputError(stderr, error)
    }
    val issues = ScenarioValidator.validate(document)
    if (issues.isNotEmpty()) return validationError(stderr, issues)

    stderr.appendLine("Valid experiment: $path")
    return 0
}

private fun run(
    text: String,
    stdout: Appendable,
    stderr: Appendable,
    experimentRunner: (ExperimentDocument) -> ExperimentResult,
): Int {
    val document = try {
        ScenarioCodec.decodeExperiment(text)
    } catch (error: Exception) {
        return inputError(stderr, error)
    }
    val issues = ScenarioValidator.validate(document)
    if (issues.isNotEmpty()) return validationError(stderr, issues)

    return execute(document, stdout, stderr, experimentRunner)
}

private fun sweep(
    text: String,
    stdout: Appendable,
    stderr: Appendable,
    experimentRunner: (ExperimentDocument) -> ExperimentResult,
): Int {
    val document = try {
        ScenarioCodec.decodeSweep(text)
    } catch (error: Exception) {
        return inputError(stderr, error)
    }
    val issues = ScenarioValidator.validate(document)
    if (issues.isNotEmpty()) return validationError(stderr, issues)
    val expanded = try {
        SweepExpander.expand(document)
    } catch (error: ScenarioValidationException) {
        return validationError(stderr, error.errors)
    }

    return execute(expanded, stdout, stderr, experimentRunner)
}

private fun execute(
    document: ExperimentDocument,
    stdout: Appendable,
    stderr: Appendable,
    experimentRunner: (ExperimentDocument) -> ExperimentResult,
): Int {
    val encoded = try {
        Json.encodeToString(ExperimentResult.serializer(), experimentRunner(document))
    } catch (error: Exception) {
        stderr.appendLine("Execution failed: ${diagnostic(error)}")
        return 1
    }
    stdout.appendLine(encoded)
    return 0
}

private fun inputError(stderr: Appendable, error: Exception): Int {
    stderr.appendLine("Invalid input: ${diagnostic(error)}")
    return 2
}

private fun validationError(stderr: Appendable, issues: List<ValidationIssue>): Int {
    stderr.appendLine("Validation failed:")
    issues.forEach { issue -> stderr.appendLine("- ${issue.path}: ${issue.message}") }
    return 2
}

private fun diagnostic(error: Throwable): String = error.message
    ?.lineSequence()
    ?.firstOrNull()
    ?.takeIf { it.isNotBlank() }
    ?: error.javaClass.simpleName
