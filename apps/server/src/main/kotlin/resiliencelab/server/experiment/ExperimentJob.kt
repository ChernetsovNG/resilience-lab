package resiliencelab.server.experiment

import resiliencelab.core.experiment.ExperimentResult
import java.util.UUID

/** Immutable snapshot of a process-local experiment job. */
data class ExperimentJob(
    val id: UUID,
    val status: ExperimentJobStatus,
    val result: ExperimentResult?,
    val error: String?,
)

/** Lifecycle states exposed for asynchronous experiment execution. */
enum class ExperimentJobStatus {
    QUEUED,
    RUNNING,
    COMPLETED,
    FAILED,
}
