package resiliencelab.server.experiment

import org.springframework.stereotype.Component
import resiliencelab.core.experiment.ExperimentResult
import resiliencelab.core.experiment.ExperimentRunner
import resiliencelab.core.scenario.ExperimentDocument

/** Executes a prepared experiment synchronously on the caller's thread. */
fun interface ExperimentExecutor {
    /** Runs [document] and returns its complete result, or throws when execution fails. */
    fun execute(document: ExperimentDocument): ExperimentResult
}

/** Production adapter that delegates experiment execution to the core KSL runner. */
@Component
class KslExperimentExecutor : ExperimentExecutor {
    override fun execute(document: ExperimentDocument): ExperimentResult = ExperimentRunner.run(document)
}
