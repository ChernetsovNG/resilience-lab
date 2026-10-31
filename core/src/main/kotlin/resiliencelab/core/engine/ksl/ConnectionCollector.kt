package resiliencelab.core.engine.ksl

import resiliencelab.core.experiment.ConnectionMetrics
import resiliencelab.core.experiment.LatencyAccumulator
import resiliencelab.core.experiment.SlotPoolMetrics
import resiliencelab.core.experiment.TimeWeightedSeries

/** Observations of the existing call lifecycle; none of these events schedules or cancels model work. */
internal enum class ConnectionEvent {
    SENT,
    RETRY,
    SUCCEEDED,
    FAILED,
    TIMEOUT,
    ORPHANED,
    ORPHAN_COMPLETED,
    BACKOFF_STARTED,
    BACKOFF_COMPLETED,
}

/** Cohort counters and fixed-interval occupancy, independent of the event-time window population. */
internal class ConnectionCollector(
    ids: List<String>,
    private val startMs: Double,
    private val endMs: Double,
    private val poolSizes: Map<String, Int> = emptyMap(),
) {
    private val states = ids.sorted().associateWith { State(it) }

    fun record(
        id: String,
        timeMs: Double,
        event: ConnectionEvent,
        measured: Boolean,
        latencyMs: Double,
    ) {
        states.getValue(id).record(timeMs, event, measured, latencyMs)
    }

    fun failure(
        id: String,
        reason: String,
        measured: Boolean,
    ) {
        if (!measured) return
        val reasons = states.getValue(id).failuresByReason
        reasons[reason] = reasons.getOrDefault(reason, 0) + 1
    }

    fun poolState(
        id: String,
        timeMs: Double,
        busy: Int?,
        queueLength: Int?,
    ) {
        states.getValue(id).apply {
            if (busy != null) poolBusy = busy
            if (queueLength != null) poolQueued = queueLength
            observe(timeMs)
        }
    }

    fun poolWait(
        id: String,
        measured: Boolean,
        waitMs: Double,
        expired: Boolean,
    ) {
        if (!measured) return
        states.getValue(id).apply {
            poolWaitCount++
            poolWaitTimeMs += waitMs
            if (expired) poolAcquireTimeouts++
        }
    }

    fun poolCapacity(
        id: String,
        timeMs: Double,
        capacity: Int,
    ) {
        states.getValue(id).apply {
            poolSize = capacity
            poolCapacitySeries.record(timeMs, capacity.toDouble())
        }
    }

    fun startMeasurement() {
        states.values.forEach { it.observe(startMs) }
    }

    fun finish(timeMs: Double) {
        states.values.forEach { state ->
            state.inFlightSeries.finish(timeMs)
            state.orphanedSeries.finish(timeMs)
            state.backoffSeries.finish(timeMs)
            state.poolBusySeries.finish(timeMs)
            state.poolQueueSeries.finish(timeMs)
            state.poolCapacitySeries.finish(timeMs)
        }
    }

    fun snapshot(): Map<String, ConnectionMetrics> = states.mapValues { (_, state) -> state.snapshot() }

    fun verifyDrained() {
        states.forEach { (id, state) ->
            check(state.inFlight == 0 && state.activeOrphaned == 0 && state.backoff == 0 && state.poolBusy == 0 && state.poolQueued == 0) {
                "connection=$id did not fully drain: inFlight=${state.inFlight}, orphaned=${state.activeOrphaned}, backoff=${state.backoff}"
            }
        }
    }

    private inner class State(
        id: String,
    ) {
        var sentAttempts = 0
        var retries = 0
        var succeeded = 0
        val failuresByReason = sortedMapOf<String, Int>()
        var failed = 0
        var timeouts = 0
        var orphaned = 0
        var poolBusy = 0
        var poolQueued = 0
        var poolSize = poolSizes[id] ?: 0
        private val ownsPool = id in poolSizes
        var poolWaitCount = 0
        var poolWaitTimeMs = 0.0
        var poolAcquireTimeouts = 0
        val poolBusySeries = TimeWeightedSeries(startMs, endMs)
        val poolQueueSeries = TimeWeightedSeries(startMs, endMs)
        val poolCapacitySeries = TimeWeightedSeries(startMs, endMs)
        var inFlight = 0
        var activeOrphaned = 0
        var backoff = 0
        val inFlightSeries = TimeWeightedSeries(startMs, endMs)
        val orphanedSeries = TimeWeightedSeries(startMs, endMs)
        val backoffSeries = TimeWeightedSeries(startMs, endMs)
        val latency = LatencyAccumulator(context = "connection=$id window=cohort response")

        fun record(
            timeMs: Double,
            event: ConnectionEvent,
            measured: Boolean,
            latencyMs: Double,
        ) {
            when (event) {
                ConnectionEvent.SENT -> {
                    inFlight++
                    if (measured) sentAttempts++
                }
                ConnectionEvent.RETRY -> if (measured) retries++
                ConnectionEvent.SUCCEEDED -> {
                    inFlight--
                    if (measured) {
                        succeeded++
                        latency.add(latencyMs)
                    }
                }
                ConnectionEvent.FAILED -> {
                    inFlight--
                    if (measured) {
                        failed++
                        latency.add(latencyMs)
                    }
                }
                ConnectionEvent.TIMEOUT -> {
                    inFlight--
                    if (measured) timeouts++
                }
                ConnectionEvent.ORPHANED -> {
                    activeOrphaned++
                    if (measured) orphaned++
                }
                ConnectionEvent.ORPHAN_COMPLETED -> activeOrphaned--
                ConnectionEvent.BACKOFF_STARTED -> backoff++
                ConnectionEvent.BACKOFF_COMPLETED -> backoff--
            }
            check(inFlight >= 0 && activeOrphaned >= 0 && backoff >= 0) { "Unbalanced connection observations" }
            observe(timeMs)
        }

        fun observe(timeMs: Double) {
            inFlightSeries.record(timeMs, inFlight.toDouble())
            orphanedSeries.record(timeMs, activeOrphaned.toDouble())
            backoffSeries.record(timeMs, backoff.toDouble())
            poolBusySeries.record(timeMs, poolBusy.toDouble())
            poolQueueSeries.record(timeMs, poolQueued.toDouble())
            poolCapacitySeries.record(timeMs, poolSize.toDouble())
        }

        fun snapshot(): ConnectionMetrics =
            ConnectionMetrics(
                sentAttempts,
                retries,
                succeeded,
                failed,
                timeouts,
                orphaned,
                inFlightSeries.integral,
                orphanedSeries.integral,
                backoffSeries.integral,
                endMs - startMs,
                latency.snapshot(),
                failuresByReason = failuresByReason.toMap(),
                slotPools =
                    if (ownsPool) {
                        mapOf(
                            "pool" to
                                SlotPoolMetrics(
                                    poolBusySeries.integral,
                                    poolQueueSeries.integral,
                                    poolCapacitySeries.integral,
                                    poolWaitCount.toLong(),
                                    poolWaitTimeMs,
                                    0L,
                                    poolAcquireTimeouts.toLong(),
                                ),
                        )
                    } else {
                        emptyMap()
                    },
            )
    }
}
