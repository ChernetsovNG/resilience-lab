package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamIfc
import ksl.utilities.random.rvariable.KSLRandom
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode

/**
 * Chains, models and streams for engine tests. [simple] is the two-service chain the MVP engine tests used;
 * streams are the path-based ones the engine uses (ADR 0006).
 */
object TestChains {
    const val CLIENT = "client"

    fun fixed(durationMs: Double): Distribution = Distribution(DistributionShape.FIXED, durationMs)

    fun exponential(meanMs: Double): Distribution = Distribution(DistributionShape.EXPONENTIAL, meanMs)

    fun backoff(
        kind: BackoffKind,
        baseMs: Double,
        maxMs: Double,
        multiplier: Double = 2.0,
    ): Backoff = Backoff(kind, baseMs, maxMs, multiplier)

    val noBackoff: Backoff = backoff(BackoffKind.NONE, 0.0, 0.0)

    fun fixedBackoff(durationMs: Double): Backoff = backoff(BackoffKind.FIXED, durationMs, durationMs)

    fun run(
        warmupMs: Double = 0.0,
        measurementMs: Double = 1_000.0,
        seed: Long = 42L,
        maxRealTimeSeconds: Long = 30L,
        replications: Int = 1,
    ): RunSettings = RunSettings(replications, warmupMs, measurementMs, seed, maxRealTimeSeconds)

    /** `client` → `entry` → `backend`: one handler and two queue places each, 20 ms fixed processing, no retries delay. */
    fun simple(): GraphIr =
        GraphIr(
            client = ClientNode(CLIENT, arrivalRatePerMs = 0.01, deadlineMs = 500.0),
            entry = "entry",
            services =
                listOf(
                    ServiceNode("entry", handlers = 1, queueCapacity = 2, processing = fixed(20.0), failureProbability = 0.0),
                    ServiceNode("backend", handlers = 1, queueCapacity = 2, processing = fixed(20.0), failureProbability = 0.0),
                ),
            calls =
                listOf(
                    CallEdge(
                        path = "entry-to-backend",
                        from = "entry",
                        to = "backend",
                        network = fixed(0.0),
                        timeoutMs = 50.0,
                        attempts = 2,
                        backoff = noBackoff,
                    ),
                ),
            faults = emptyList(),
            run = run(),
        )

    /** Engine model of one replication of [chain] with path-based streams. */
    fun reliabilityModel(
        model: Model,
        chain: GraphIr,
        replication: Int = 0,
    ): ReliabilityModel {
        val plan = StreamPlan(PathStreams.keys(chain, replication))
        return ReliabilityModel(model, chain, PathStreamSource(plan, chain.run.seed, replication.toLong()))
    }

    /** A fresh copy of the stream the engine uses for [role] of [path]. */
    fun stream(
        seed: Long,
        path: String,
        role: StreamRole,
        replication: Int = 0,
    ): RNStreamIfc = PathStreams.streamAt(PathStreams.addressOf(StreamKey(seed, replication.toLong(), path.split('/'), role.id)))

    /** Original arrivals before [endMs], drawn as the engine draws them from the client's arrivals stream. */
    fun expectedArrivals(
        seed: Long,
        arrivalRatePerMs: Double,
        endMs: Double,
        replication: Int = 0,
    ): List<Double> {
        val arrivals = stream(seed, CLIENT, StreamRole.ARRIVALS, replication)
        return buildList {
            var timeMs = 0.0
            while (true) {
                timeMs += KSLRandom.rExponential(1 / arrivalRatePerMs, arrivals)
                if (timeMs >= endMs) break
                add(timeMs)
            }
        }
    }
}
