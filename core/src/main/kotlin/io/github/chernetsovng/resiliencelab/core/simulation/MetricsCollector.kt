package io.github.chernetsovng.resiliencelab.core.simulation

import io.github.chernetsovng.resiliencelab.core.experiment.ReplicationResult
import io.github.chernetsovng.resiliencelab.core.experiment.ServiceMetrics

class MetricsCollector(serviceIds: List<String>) {
    private val arrivalTimesMs = mutableListOf<Double>()
    private val allLatenciesMs = mutableListOf<Double>()
    private val successfulLatenciesMs = mutableListOf<Double>()
    private val failedLatenciesMs = mutableListOf<Double>()
    private var originalArrivals = 0
    private var successes = 0
    private var failures = 0
    private val serviceMetrics = serviceIds.associateTo(linkedMapOf()) { it to MutableServiceMetrics() }

    fun replicationResult(): ReplicationResult = ReplicationResult(
        arrivalTimesMs = arrivalTimesMs.toList(),
        allLatenciesMs = allLatenciesMs.toList(),
        successfulLatenciesMs = successfulLatenciesMs.toList(),
        failedLatenciesMs = failedLatenciesMs.toList(),
        originalArrivals = originalArrivals,
        successes = successes,
        failures = failures,
        services = serviceMetrics.mapValues { (_, metrics) -> metrics.snapshot() },
    )

    internal fun reset() {
        arrivalTimesMs.clear()
        allLatenciesMs.clear()
        successfulLatenciesMs.clear()
        failedLatenciesMs.clear()
        originalArrivals = 0
        successes = 0
        failures = 0
        serviceMetrics.values.forEach { it.reset() }
    }

    internal fun recordOriginalArrival(timeMs: Double) {
        arrivalTimesMs += timeMs
        originalArrivals++
    }

    internal fun recordOriginalCompletion(arrivalTimeMs: Double, completionTimeMs: Double, succeeded: Boolean) {
        val latencyMs = completionTimeMs - arrivalTimeMs
        allLatenciesMs += latencyMs
        if (succeeded) {
            successfulLatenciesMs += latencyMs
            successes++
        } else {
            failedLatenciesMs += latencyMs
            failures++
        }
    }

    internal fun recordOffered(serviceId: String) {
        serviceMetrics.getValue(serviceId).offeredAttempts++
    }

    internal fun recordAdmitted(serviceId: String) {
        serviceMetrics.getValue(serviceId).admittedAttempts++
    }

    internal fun recordLocalFailure(serviceId: String) {
        serviceMetrics.getValue(serviceId).failures++
    }

    internal fun recordQueueRejection(serviceId: String) {
        serviceMetrics.getValue(serviceId).queueRejections++
    }

    private class MutableServiceMetrics {
        var offeredAttempts = 0
        var admittedAttempts = 0
        var failures = 0
        var queueRejections = 0

        fun reset() {
            offeredAttempts = 0
            admittedAttempts = 0
            failures = 0
            queueRejections = 0
        }

        fun snapshot(): ServiceMetrics = ServiceMetrics(
            offeredAttempts = offeredAttempts,
            admittedAttempts = admittedAttempts,
            timeouts = 0,
            retries = 0,
            failures = failures,
            queueRejections = queueRejections,
            handlerUtilization = 0.0,
            meanQueueLength = 0.0,
            p95QueueLength = 0.0,
        )
    }
}
