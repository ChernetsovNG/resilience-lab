package resiliencelab.server.api

import kotlinx.serialization.Serializable
import resiliencelab.core.scenario.ExperimentDocument
import resiliencelab.core.scenario.SweepDocument

/** A submission containing exactly one direct experiment or parameter sweep. */
@Serializable
data class ExperimentSubmission(
    val experiment: ExperimentDocument? = null,
    val sweep: SweepDocument? = null,
)
