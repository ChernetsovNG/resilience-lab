package resiliencelab.server.lab

import resiliencelab.core.lab.Lab
import java.util.concurrent.Executor

/** Process-local jobs; implemented in the jobs task of the server plan. */
class JobService(
    private val lab: Lab,
    private val executor: Executor,
    private val maxTerminalJobs: Int = 100,
    private val newRunId: () -> String,
)
