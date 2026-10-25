package io.github.chernetsovng.resiliencelab.core.simulation

import io.github.chernetsovng.resiliencelab.core.scenario.Execution
import io.github.chernetsovng.resiliencelab.core.scenario.Scenario
import ksl.modeling.entity.KSLProcess
import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model

class ReliabilityModel(model: Model, scenario: Scenario, execution: Execution) : ProcessModel(model) {
    private val randomStreams = model.streamProvider.apply {
        initialSeed(SeedFactory.seedVector(execution.seed))
    }
    val metrics = MetricsCollector(scenario.services.map { it.id })
    private val runtimes = scenario.services.mapIndexed { index, service ->
        ServiceRuntime(
            parent = this,
            spec = service,
            streamProvider = randomStreams,
            durationStreamNum = index * 2 + 1,
            failureStreamNum = index * 2 + 2,
            onAdmitted = ::recordAdmission,
        )
    }.associateBy { it.serviceId }

    var activeInvocations: Int = 0
        private set
    var activeOriginalRequests: Int = 0
        private set

    override fun initialize() {
        metrics.reset()
        activeInvocations = 0
        activeOriginalRequests = 0
    }

    fun invoke(
        serviceId: String,
        timeUntilActivation: Double = 0.0,
        originalRequest: Boolean = false,
    ): ServiceInvocation {
        val runtime = requireNotNull(runtimes[serviceId]) { "Unknown service '$serviceId'" }
        val invocation = ServiceInvocation(
            runtime = runtime,
            originalRequest = originalRequest,
            arrivalTimeMs = time + timeUntilActivation,
        )
        activate(invocation.work, timeUntilActivation)
        return invocation
    }

    private fun recordAdmission(entity: ProcessModel.Entity) {
        (entity as ServiceInvocation).recordAdmission()
    }

    inner class ServiceInvocation internal constructor(
        private val runtime: ServiceRuntime,
        private val originalRequest: Boolean,
        private val arrivalTimeMs: Double,
    ) : Entity() {
        private var currentOutcome: AttemptOutcome = AttemptOutcome.PENDING
        private var admitted = false

        val outcome: AttemptOutcome
            get() = currentOutcome

        internal fun recordAdmission() {
            check(!admitted) { "Invocation was already admitted" }
            admitted = true
            activeInvocations++
            metrics.recordAdmitted(runtime.serviceId)
        }

        internal val work: KSLProcess = process("service:${runtime.serviceId}") {
            metrics.recordOffered(runtime.serviceId)
            if (originalRequest) {
                activeOriginalRequests++
                metrics.recordOriginalArrival(arrivalTimeMs)
            }
            try {
                val allocation = seize(runtime.resource)
                try {
                    val durationMs = runtime.nextDurationMs()
                    val localFailure = runtime.nextLocalFailure()
                    delay(durationMs)
                    if (localFailure) {
                        currentOutcome = AttemptOutcome.LOCAL_FAILURE
                        metrics.recordLocalFailure(runtime.serviceId)
                    } else {
                        currentOutcome = AttemptOutcome.SUCCEEDED
                    }
                } finally {
                    release(allocation)
                }
            } catch (exception: QueueFullException) {
                currentOutcome = AttemptOutcome.QUEUE_REJECTED
                metrics.recordQueueRejection(runtime.serviceId)
            } finally {
                if (admitted) {
                    activeInvocations--
                    admitted = false
                }
                if (originalRequest) {
                    activeOriginalRequests--
                    if (currentOutcome != AttemptOutcome.PENDING) {
                        metrics.recordOriginalCompletion(
                            arrivalTimeMs = arrivalTimeMs,
                            completionTimeMs = time,
                            succeeded = currentOutcome == AttemptOutcome.SUCCEEDED,
                        )
                    }
                }
            }
        }
    }
}
