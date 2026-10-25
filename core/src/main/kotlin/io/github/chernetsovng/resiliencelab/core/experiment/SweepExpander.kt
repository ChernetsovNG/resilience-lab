package io.github.chernetsovng.resiliencelab.core.experiment

import io.github.chernetsovng.resiliencelab.core.scenario.ExperimentDocument
import io.github.chernetsovng.resiliencelab.core.scenario.ExperimentVariant
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import io.github.chernetsovng.resiliencelab.core.scenario.ScenarioValidator
import io.github.chernetsovng.resiliencelab.core.scenario.SweepDocument
import io.github.chernetsovng.resiliencelab.core.scenario.SweepParameter

object SweepExpander {
    fun expand(document: SweepDocument): ExperimentDocument {
        ScenarioValidator.requireValid(document)
        val expanded = ExperimentDocument(
            schemaVersion = document.schemaVersion,
            execution = document.execution,
            variants = document.sweep.values.mapIndexed { index, value ->
                ExperimentVariant(
                    id = "sweep-$index",
                    label = "sweep-$index",
                    scenario = scenarioForValue(document, value),
                    sweepParameter = document.sweep.parameter,
                    sweepValue = value,
                )
            },
        )
        ScenarioValidator.requireValid(expanded)
        return expanded
    }

    private fun scenarioForValue(document: SweepDocument, value: Double): Scenario {
        val base = document.baseScenario
        return when (document.sweep.parameter) {
            SweepParameter.ARRIVAL_RATE -> base.copy(
                workload = base.workload.copy(arrivalRate = value),
            )
            SweepParameter.LINK_TIMEOUT -> base.copy(
                links = base.links.map { link ->
                    if (link.id == document.sweep.linkId) link.copy(timeoutMs = value) else link
                },
            )
            SweepParameter.MAX_ATTEMPTS -> base.copy(
                links = base.links.map { link ->
                    if (link.id == document.sweep.linkId) link.copy(maxAttempts = value.toInt()) else link
                },
            )
            SweepParameter.BACKOFF_BASE -> base.copy(
                links = base.links.map { link ->
                    if (link.id == document.sweep.linkId) {
                        link.copy(retry = link.retry.copy(baseBackoffMs = value))
                    } else {
                        link
                    }
                },
            )
            SweepParameter.DEGRADATION_MULTIPLIER -> base.copy(
                degradation = base.degradation!!.copy(processingMultiplier = value),
            )
        }
    }
}
