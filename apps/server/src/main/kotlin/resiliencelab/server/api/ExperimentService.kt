package resiliencelab.server.api

import org.springframework.stereotype.Service
import resiliencelab.core.experiment.SweepExpander
import resiliencelab.core.scenario.ExperimentDocument
import resiliencelab.core.scenario.ScenarioValidator

/** Prepares submitted experiments for execution without creating or running jobs. */
@Service
class ExperimentService {
    /** Validates a direct experiment or validates and expands a sweep through core. */
    fun prepare(submission: ExperimentSubmission): ExperimentDocument =
        when {
            submission.experiment != null && submission.sweep == null -> {
                ScenarioValidator.requireValid(submission.experiment)
                submission.experiment
            }
            submission.sweep != null && submission.experiment == null -> SweepExpander.expand(submission.sweep)
            else -> throw IllegalArgumentException("Exactly one of experiment or sweep must be provided")
        }
}
