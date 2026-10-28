package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.RetryKind
import resiliencelab.core.scenario.RetrySpec
import resiliencelab.core.scenario.Scenario

/**
 * Maps MVP scenarios onto the chain IR and the MVP stream numbering, so the legacy API and its tests keep their
 * exact behaviour. Removed together with the `scenario` package once the web client leaves the MVP API.
 */
internal object LegacyScenarioAdapter {
    const val CLIENT_PATH = "workload"

    fun chain(
        scenario: Scenario,
        execution: Execution,
    ): ChainIr =
        ChainIr(
            client = ClientNode(CLIENT_PATH, scenario.workload.arrivalRate, scenario.workload.requestDeadlineMs),
            entry = scenario.entry,
            services =
                scenario.services.map {
                    ServiceNode(it.id, it.handlers, it.queueCapacity, distribution(it.processing), it.failureRate)
                },
            calls =
                scenario.links.map {
                    CallEdge(it.id, it.from, it.to, distribution(it.network), it.timeoutMs, it.maxAttempts, backoff(it.retry))
                },
            faults =
                listOfNotNull(
                    scenario.degradation?.let {
                        FaultSpan(it.serviceId, it.startMs, it.endMs, it.processingMultiplier, it.failureRate)
                    },
                ),
            run =
                RunSettings(
                    replications = execution.replications,
                    warmupMs = execution.warmupMs,
                    measurementMs = execution.measurementMs,
                    seed = execution.seed,
                    maxRealTimeSeconds = execution.maxRealTimeSeconds,
                ),
        )

    fun distribution(spec: DurationDistribution): Distribution =
        Distribution(
            shape =
                when (spec.kind) {
                    DistributionKind.FIXED -> DistributionShape.FIXED
                    DistributionKind.EXPONENTIAL -> DistributionShape.EXPONENTIAL
                    DistributionKind.LOGNORMAL -> DistributionShape.LOGNORMAL
                },
            meanMs = spec.meanMs,
            stdDevMs = spec.stdDevMs,
        )

    fun backoff(retry: RetrySpec): Backoff =
        Backoff(
            kind =
                when (retry.kind) {
                    RetryKind.NONE -> BackoffKind.NONE
                    RetryKind.FIXED -> BackoffKind.FIXED
                    RetryKind.EXPONENTIAL_FULL_JITTER -> BackoffKind.EXPONENTIAL_FULL_JITTER
                },
            baseMs = retry.baseBackoffMs,
            maxMs = retry.maxBackoffMs,
            multiplier = retry.base,
        )

    /** MVP numbering: services by index, then links, then arrivals, on the model provider seeded from [seed]. */
    fun streams(
        model: Model,
        scenario: Scenario,
        seed: Long,
    ): StreamSource {
        val provider = model.streamProvider.apply { initialSeed(SeedFactory.seedVector(seed)) }
        val services = scenario.services.size
        val links = scenario.links.size
        val numbers = HashMap<Pair<String, StreamRole>, Int>()
        scenario.services.forEachIndexed { index, service ->
            numbers[service.id to StreamRole.PROCESSING] = index * 2 + 1
            numbers[service.id to StreamRole.OUTCOME] = index * 2 + 2
        }
        scenario.links.forEachIndexed { index, link ->
            numbers[link.id to StreamRole.NETWORK] = services * 2 + index + 1
            numbers[link.id to StreamRole.JITTER] = services * 2 + links + index + 1
        }
        numbers[CLIENT_PATH to StreamRole.ARRIVALS] = services * 2 + links * 2 + 1
        return StreamSource { path, role -> provider.rnStream(numbers.getValue(path to role)) }
    }
}
