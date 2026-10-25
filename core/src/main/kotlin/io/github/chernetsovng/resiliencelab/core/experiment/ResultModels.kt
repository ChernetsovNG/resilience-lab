package io.github.chernetsovng.resiliencelab.core.experiment

import kotlinx.serialization.Serializable

@Serializable
data class ReplicationResult(
    val arrivalTimesMs: List<Double>,
    val allLatenciesMs: List<Double>,
    val successfulLatenciesMs: List<Double>,
    val failedLatenciesMs: List<Double>,
    val originalArrivals: Int,
    val successes: Int,
    val failures: Int,
    val services: Map<String, ServiceMetrics>,
)

@Serializable
data class ServiceMetrics(
    val offeredAttempts: Int,
    val admittedAttempts: Int,
    val timeouts: Int,
    val retries: Int,
    val failures: Int,
    val queueRejections: Int,
    val handlerUtilization: Double,
    val meanQueueLength: Double,
    val p95QueueLength: Double,
)
