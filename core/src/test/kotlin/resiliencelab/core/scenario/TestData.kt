package resiliencelab.core.scenario

object TestData {
    fun simpleScenario(): Scenario = Scenario(
        entry = "entry",
        services = listOf(
            ServiceSpec(
                id = "entry",
                handlers = 1,
                queueCapacity = 2,
                processing = DurationDistribution(
                    kind = DistributionKind.FIXED,
                    meanMs = 20.0,
                    stdDevMs = null,
                ),
                failureRate = 0.0,
            ),
            ServiceSpec(
                id = "backend",
                handlers = 1,
                queueCapacity = 2,
                processing = DurationDistribution(
                    kind = DistributionKind.FIXED,
                    meanMs = 20.0,
                    stdDevMs = null,
                ),
                failureRate = 0.0,
            ),
        ),
        links = listOf(
            LinkSpec(
                id = "entry-to-backend",
                from = "entry",
                to = "backend",
                network = DurationDistribution(
                    kind = DistributionKind.FIXED,
                    meanMs = 0.0,
                    stdDevMs = null,
                ),
                timeoutMs = 50.0,
                maxAttempts = 2,
                retry = RetrySpec(
                    kind = RetryKind.NONE,
                    baseBackoffMs = 0.0,
                    maxBackoffMs = 0.0,
                ),
            ),
        ),
        workload = WorkloadSpec(
            arrivalRate = 0.01,
            requestDeadlineMs = 500.0,
        ),
        degradation = null,
    )
}
