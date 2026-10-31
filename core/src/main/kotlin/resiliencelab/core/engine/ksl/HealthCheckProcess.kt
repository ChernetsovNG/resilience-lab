package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.KSLEvent
import ksl.simulation.ModelElement
import resiliencelab.core.ir.HealthCheckConfig

/**
 * One checker per instance, independent of the original-request cohort and its random streams.
 * The first probe starts at [HealthCheckConfig.intervalMs]; later probes wait for both the interval and
 * the previous result. A timed-out queued probe leaves the queue; admitted processing still releases its
 * handler only on completion. Processing-delay/capacity faults apply, but request scenarios do not run.
 */
internal class HealthCheckProcess(
    parent: ModelElement,
    private val runtime: ServiceRuntime,
    private val config: HealthCheckConfig,
    private val onStarted: () -> Unit,
    private val onCompleted: (Boolean) -> Unit,
) : ProcessModel(parent, "${runtime.serviceId}:health-check") {
    override fun initialize() {
        scheduleProbe(config.intervalMs)
    }

    private fun scheduleProbe(delayMs: Double) {
        schedule(
            EventActionIfc<Nothing> {
                onStarted()
                val probe = Probe()
                activate(probe.work)
            },
            delayMs,
        )
    }

    private inner class Probe : Entity() {
        private val startedMs = time
        private var completed = false
        private val timeout =
            schedule(
                EventActionIfc<Nothing> { complete(false) },
                config.timeoutMs,
                priority = KSLEvent.DEFAULT_PRIORITY + 2,
            )

        private fun complete(succeeded: Boolean) {
            if (completed) return
            completed = true
            if (timeout.isScheduled) timeout.cancel = true
            onCompleted(succeeded)
            runtime.health?.complete(succeeded)
            scheduleProbe(maxOf(0.0, startedMs + config.intervalMs - time))
        }

        val work =
            process("probe:${runtime.serviceId}") {
                val acquired = with(runtime.slots) { acquire(config.timeoutMs) }
                val allocation = acquired.allocation
                if (allocation == null) {
                    complete(false)
                } else {
                    try {
                        delay(config.processingMs * runtime.faults.multiplier + runtime.faults.delayMs)
                        complete(true)
                    } finally {
                        release(allocation)
                    }
                }
            }
    }
}
