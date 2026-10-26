package resiliencelab.core.simulation

import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.experiment.ServiceMetrics
import resiliencelab.core.experiment.TimeWeightedSeries
import resiliencelab.core.scenario.ServiceSpec

class MetricsCollector(
    services: List<ServiceSpec>,
    private val measurementStartMs: Double,
    private val measurementEndMs: Double,
    private val currentTimeMs: () -> Double,
) {
    private val arrivalTimesMs = mutableListOf<Double>()
    private val allLatenciesMs = mutableListOf<Double>()
    private val successfulLatenciesMs = mutableListOf<Double>()
    private val failedLatenciesMs = mutableListOf<Double>()
    private var originalArrivals = 0
    private var successes = 0
    private var failures = 0
    private val serviceMetrics = services.associateTo(linkedMapOf()) { service ->
        service.id to MutableServiceMetrics(service.handlers, measurementStartMs, measurementEndMs)
    }

    fun replicationResult(): ReplicationResult {
        val timeMs = currentTimeMs()
        if (timeMs >= measurementEndMs) {
            finishMeasurement(timeMs)
        }
        return ReplicationResult(
            arrivalTimesMs = arrivalTimesMs.toList(),
            allLatenciesMs = allLatenciesMs.toList(),
            successfulLatenciesMs = successfulLatenciesMs.toList(),
            failedLatenciesMs = failedLatenciesMs.toList(),
            originalArrivals = originalArrivals,
            successes = successes,
            failures = failures,
            services = serviceMetrics.mapValues { (_, metrics) -> metrics.snapshot() },
        )
    }

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

    internal fun startMeasurement(serviceId: String, queueLength: Int, busyHandlers: Int) {
        val metrics = serviceMetrics.getValue(serviceId)
        metrics.queueLengthSeries.record(measurementStartMs, queueLength.toDouble())
        metrics.busyHandlerSeries.record(measurementStartMs, busyHandlers.toDouble())
    }

    internal fun recordQueueLength(serviceId: String, timeMs: Double, queueLength: Int) {
        serviceMetrics.getValue(serviceId).queueLengthSeries.record(timeMs, queueLength.toDouble())
    }

    internal fun recordBusyHandlers(serviceId: String, timeMs: Double, busyHandlers: Int) {
        serviceMetrics.getValue(serviceId).busyHandlerSeries.record(timeMs, busyHandlers.toDouble())
    }

    internal fun finishMeasurement(timeMs: Double) {
        serviceMetrics.values.forEach { it.finish(timeMs) }
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

    internal fun recordTimeout(serviceId: String) {
        serviceMetrics.getValue(serviceId).timeouts++
    }

    internal fun recordRetry(serviceId: String) {
        serviceMetrics.getValue(serviceId).retries++
    }

    private class MutableServiceMetrics(
        private val configuredHandlers: Int,
        private val measurementStartMs: Double,
        private val measurementEndMs: Double,
    ) {
        var offeredAttempts = 0
        var admittedAttempts = 0
        var timeouts = 0
        var retries = 0
        var failures = 0
        var queueRejections = 0
        var queueLengthSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)
        var busyHandlerSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)

        fun reset() {
            offeredAttempts = 0
            admittedAttempts = 0
            timeouts = 0
            retries = 0
            failures = 0
            queueRejections = 0
            queueLengthSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)
            busyHandlerSeries = TimeWeightedSeries(measurementStartMs, measurementEndMs)
        }

        fun finish(timeMs: Double) {
            queueLengthSeries.finish(timeMs)
            busyHandlerSeries.finish(timeMs)
        }

        fun snapshot(): ServiceMetrics = ServiceMetrics(
            offeredAttempts = offeredAttempts,
            admittedAttempts = admittedAttempts,
            timeouts = timeouts,
            retries = retries,
            failures = failures,
            queueRejections = queueRejections,
            handlerUtilization = busyHandlerSeries.average / configuredHandlers,
            meanQueueLength = queueLengthSeries.average,
            p95QueueLength = queueLengthSeries.p95,
        )
    }
}
