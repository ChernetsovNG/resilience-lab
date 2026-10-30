package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import ksl.simulation.ModelElement
import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class SlotPoolTest {
    @Test
    fun `idle acquisition is immediate and full queue rejects separately`() {
        val rig = simulate(queueCapacity = 1, attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("waiter", 1.0), Attempt("full", 2.0)))

        assertThat(rig.outcomes).containsExactlyEntriesOf(
            mapOf(
                "holder" to SlotAcquisitionOutcome.IMMEDIATE,
                "full" to SlotAcquisitionOutcome.QUEUE_FULL,
                "waiter" to SlotAcquisitionOutcome.WAITED,
            ),
        )
        assertThat(rig.acquiredAt).containsExactlyEntriesOf(mapOf("holder" to 0.0, "waiter" to 10.0))
        assertThat(rig.snapshots.single().queueFullCount).isEqualTo(1)
    }

    @Test
    fun `zero queue accepts only immediately available slots`() {
        val rig = simulate(queueCapacity = 0, attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("full", 1.0), Attempt("later", 12.0)))

        assertThat(rig.outcomes).containsExactlyEntriesOf(
            mapOf(
                "holder" to SlotAcquisitionOutcome.IMMEDIATE,
                "full" to SlotAcquisitionOutcome.QUEUE_FULL,
                "later" to SlotAcquisitionOutcome.IMMEDIATE,
            ),
        )
        assertThat(rig.snapshots.single().waitCount).isZero()
    }

    @Test
    fun `queued requests acquire FIFO`() {
        val rig = simulate(attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("first", 1.0), Attempt("second", 1.0)))

        assertThat(rig.acquiredAt).containsExactlyEntriesOf(mapOf("holder" to 0.0, "first" to 10.0, "second" to 11.0))
        assertThat(rig.waits).containsAllEntriesOf(mapOf("first" to 9.0, "second" to 10.0))
    }

    @Test
    fun `wait limit removes request and a later acquisition proceeds`() {
        val rig =
            simulate(waitLimitMs = 3.0, attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("expired", 1.0), Attempt("later", 12.0)))

        assertThat(rig.outcomes["expired"]).isEqualTo(SlotAcquisitionOutcome.WAIT_LIMIT)
        assertThat(rig.completedAt["expired"]).isEqualTo(4.0)
        assertThat(rig.waits["expired"]).isEqualTo(3.0)
        assertThat(rig.acquiredAt["later"]).isEqualTo(12.0)
        assertThat(rig.pool.queue.size).isZero()
        assertThat(rig.snapshots.single().waitLimitCount).isEqualTo(1)
    }

    @Test
    fun `release at exact wait limit wins`() {
        val rig = simulate(waitLimitMs = 3.0, attempts = listOf(Attempt("holder", 0.0, 4.0), Attempt("waiter", 1.0)))

        assertThat(rig.outcomes["waiter"]).isEqualTo(SlotAcquisitionOutcome.WAITED)
        assertThat(rig.acquiredAt["waiter"]).isEqualTo(4.0)
        assertThat(rig.snapshots.single().waitLimitCount).isZero()
    }

    @Test
    fun `capacity reduction below busy and to zero lets work finish before queued work`() {
        val rig =
            simulate(
                capacity = 2,
                changes = listOf(2.0 to 0, 12.0 to 1),
                replications = 2,
                attempts = listOf(Attempt("first", 0.0, 5.0), Attempt("second", 0.0, 10.0), Attempt("waiter", 3.0)),
            )

        assertThat(rig.completedAt).containsAllEntriesOf(mapOf("first" to 5.0, "second" to 10.0, "waiter" to 13.0))
        assertThat(rig.acquiredAt["waiter"]).isEqualTo(12.0)
        assertThat(rig.snapshots.last().busyIntegralMs).isEqualTo(16.0)
        assertThat(rig.snapshots.last().capacityIntegralMs).isEqualTo(22.0)
    }

    @Test
    fun `capacity growth at exact wait limit serves FIFO head`() {
        val rig =
            simulate(
                waitLimitMs = 3.0,
                changes = listOf(4.0 to 3),
                attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("first", 1.0), Attempt("second", 1.0)),
            )

        assertThat(rig.acquiredAt).containsExactlyEntriesOf(mapOf("holder" to 0.0, "first" to 4.0, "second" to 4.0))
        assertThat(rig.snapshots.single().waitLimitCount).isZero()
    }

    @Test
    fun `capacity changes with empty queue affect subsequent admission`() {
        val rig =
            simulate(
                queueCapacity = 0,
                changes = listOf(1.0 to 0, 5.0 to 2),
                attempts = listOf(Attempt("full", 2.0), Attempt("first", 6.0), Attempt("second", 6.0)),
            )

        assertThat(rig.outcomes["full"]).isEqualTo(SlotAcquisitionOutcome.QUEUE_FULL)
        assertThat(rig.acquiredAt).containsExactlyEntriesOf(mapOf("first" to 6.0, "second" to 6.0))
        assertThat(rig.snapshots.single().capacityIntegralMs).isEqualTo(51.0)
    }

    @Test
    fun `wait and refusal metrics and integrals reset between replications`() {
        val rig =
            simulate(
                queueCapacity = 2,
                waitLimitMs = 3.0,
                replications = 2,
                attempts = listOf(Attempt("holder", 0.0, 4.0), Attempt("waiter", 1.0, 4.0), Attempt("expired", 2.0), Attempt("full", 3.0)),
            )

        assertThat(rig.snapshots).hasSize(2)
        assertThat(rig.snapshots[1]).isEqualTo(rig.snapshots[0])
        val metrics = rig.snapshots.first()
        assertThat(metrics.busyIntegralMs).isEqualTo(8.0)
        assertThat(metrics.queueIntegralMs).isEqualTo(6.0)
        assertThat(metrics.capacityIntegralMs).isEqualTo(30.0)
        assertThat(metrics.waitCount).isEqualTo(2)
        assertThat(metrics.totalWaitMs).isEqualTo(6.0)
        assertThat(metrics.queueFullCount).isEqualTo(1)
        assertThat(metrics.waitLimitCount).isEqualTo(1)
    }

    @Test
    fun `same-instant queued acquisition still reports waited`() {
        val rig = simulate(attempts = listOf(Attempt("holder", 0.0, 0.0), Attempt("waiter", 0.0)))

        assertThat(rig.outcomes["waiter"]).isEqualTo(SlotAcquisitionOutcome.WAITED)
        assertThat(rig.waits["waiter"]).isZero()
        assertThat(rig.snapshots.single().waitCount).isEqualTo(1)
    }

    @Test
    fun `zero wait limit rejects occupied capacity after immediate allocation is considered`() {
        val rig = simulate(waitLimitMs = 0.0, attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("expired", 1.0)))

        assertThat(rig.outcomes["holder"]).isEqualTo(SlotAcquisitionOutcome.IMMEDIATE)
        assertThat(rig.outcomes["expired"]).isEqualTo(SlotAcquisitionOutcome.WAIT_LIMIT)
        assertThat(rig.completedAt["expired"]).isEqualTo(1.0)
        assertThat(rig.snapshots.single().waitCount).isEqualTo(1)
    }

    @Test
    fun `expired head removal allows successor to acquire without stale reservation`() {
        val rig =
            simulate(waitLimitMs = 3.0, attempts = listOf(Attempt("holder", 0.0, 5.0), Attempt("expired", 1.0), Attempt("successor", 3.0)))

        assertThat(rig.outcomes["expired"]).isEqualTo(SlotAcquisitionOutcome.WAIT_LIMIT)
        assertThat(rig.outcomes["successor"]).isEqualTo(SlotAcquisitionOutcome.WAITED)
        assertThat(rig.acquiredAt["successor"]).isEqualTo(5.0)
        assertThat(rig.pool.queue.size).isZero()
        assertThat(rig.pool.resource.numBusy).isZero()
    }

    @Test
    fun `reduced positive capacity waits for busy work to drain below the new limit`() {
        val rig =
            simulate(
                capacity = 2,
                changes = listOf(2.0 to 1),
                attempts = listOf(Attempt("first", 0.0, 5.0), Attempt("second", 0.0, 10.0), Attempt("waiter", 3.0)),
            )

        assertThat(rig.acquiredAt["waiter"]).isEqualTo(10.0)
        assertThat(rig.completedAt["first"]).isEqualTo(5.0)
        assertThat(rig.snapshots.single().capacityIntegralMs).isEqualTo(32.0)
    }

    @Test
    fun `growth followed synchronously by loss does not leave stale wakeup promises`() {
        val rig =
            simulate(
                waitLimitMs = 8.0,
                changes = listOf(4.0 to 3, 4.0 to 0, 6.0 to 3),
                attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("first", 1.0), Attempt("second", 1.0)),
            )

        assertThat(rig.acquiredAt).containsExactlyEntriesOf(mapOf("holder" to 0.0, "first" to 6.0, "second" to 6.0))
        assertThat(rig.snapshots.single().waitLimitCount).isZero()
        assertThat(rig.snapshots.single().capacityIntegralMs).isEqualTo(76.0)
    }

    @Test
    fun `release followed synchronously by capacity loss does not strand a timed waiter`() {
        val rig =
            simulate(
                waitLimitMs = 8.0,
                changes = listOf(6.0 to 1),
                attempts = listOf(Attempt("holder", 0.0, 4.0, capacityAfterRelease = 0), Attempt("waiter", 1.0)),
            )

        assertThat(rig.acquiredAt["waiter"]).isEqualTo(6.0)
        assertThat(rig.outcomes["waiter"]).isEqualTo(SlotAcquisitionOutcome.WAITED)
        assertThat(rig.pool.queue.size).isZero()
    }

    @Test
    fun `capacity loss between native notification and waiter resumption preserves FIFO and original waits`() {
        val rig =
            simulate(
                waitLimitMs = 8.0,
                interleavedCapacities = 2 to 0,
                changes = listOf(6.0 to 2),
                attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("first", 1.0), Attempt("second", 1.0)),
            )

        assertThat(rig.acquiredAt).containsExactlyEntriesOf(mapOf("holder" to 0.0, "first" to 6.0, "second" to 7.0))
        assertThat(rig.waits).containsAllEntriesOf(mapOf("first" to 5.0, "second" to 6.0))
        val metrics = rig.snapshots.single()
        assertThat(metrics.waitCount).isEqualTo(2)
        assertThat(metrics.totalWaitMs).isEqualTo(11.0)
        assertThat(metrics.queueIntegralMs).isEqualTo(11.0)
        assertThat(metrics.waitLimitCount).isZero()
        assertThat(rig.admittedCount).isEqualTo(3)
        assertThat(rig.pool.queue.size).isZero()
        assertThat(rig.pool.resource.numBusy).isZero()
    }

    @Test
    fun `two issued promises recover from partial capacity loss without duplicate resumes`() {
        val rig =
            simulate(
                waitLimitMs = 8.0,
                interleavedCapacities = 3 to 2,
                attempts = listOf(Attempt("holder", 0.0, 10.0), Attempt("first", 1.0), Attempt("second", 1.0)),
            )

        assertThat(rig.acquiredAt).containsExactlyEntriesOf(mapOf("holder" to 0.0, "first" to 4.0, "second" to 5.0))
        assertThat(rig.waits).containsAllEntriesOf(mapOf("first" to 3.0, "second" to 4.0))
        assertThat(rig.snapshots.single().totalWaitMs).isEqualTo(7.0)
        assertThat(rig.snapshots.single().waitCount).isEqualTo(2)
        assertThat(rig.snapshots.single().waitLimitCount).isZero()
        assertThat(rig.admittedCount).isEqualTo(3)
    }

    private fun simulate(
        capacity: Int = 1,
        queueCapacity: Int = 3,
        waitLimitMs: Double? = null,
        changes: List<Pair<Double, Int>> = emptyList(),
        attempts: List<Attempt>,
        replications: Int = 1,
        interleavedCapacities: Pair<Int, Int>? = null,
    ): Rig {
        val model = Model("SlotPoolTest", autoCSVReports = false)
        val rig = Rig(model, capacity, queueCapacity, waitLimitMs, changes, attempts, interleavedCapacities)
        model.numberOfReplications = replications
        model.lengthOfReplication = 30.0
        model.simulate()
        return rig
    }

    private data class Attempt(
        val label: String,
        val at: Double,
        val duration: Double = 1.0,
        val capacityAfterRelease: Int? = null,
    )

    private class Rig(
        parent: ModelElement,
        capacity: Int,
        queueCapacity: Int,
        waitLimitMs: Double?,
        private val changes: List<Pair<Double, Int>>,
        private val attempts: List<Attempt>,
        private val interleavedCapacities: Pair<Int, Int>?,
    ) : ProcessModel(parent, null) {
        var admittedCount = 0
        val pool = SlotPool(this, "slots", capacity, queueCapacity, waitLimitMs, onAdmitted = { admittedCount++ })
        val outcomes = linkedMapOf<String, SlotAcquisitionOutcome>()
        val acquiredAt = linkedMapOf<String, Double>()
        val completedAt = linkedMapOf<String, Double>()
        val waits = linkedMapOf<String, Double>()
        val snapshots = mutableListOf<SlotPoolMetrics>()

        override fun initialize() {
            admittedCount = 0
            outcomes.clear()
            acquiredAt.clear()
            completedAt.clear()
            waits.clear()
            changes.groupBy({ it.first }, { it.second }).forEach { (at, capacities) ->
                schedule(EventActionIfc<Nothing> { capacities.forEach(pool::changeCapacity) }, at)
            }
            if (interleavedCapacities != null) {
                schedule(
                    EventActionIfc<Nothing> {
                        pool.changeCapacity(interleavedCapacities.first)
                        schedule(
                            EventActionIfc<Nothing> { pool.changeCapacity(interleavedCapacities.second) },
                            0.0,
                            priority = RELEASE_PRIORITY,
                        )
                    },
                    4.0,
                    priority = RELEASE_PRIORITY,
                )
            }
            attempts.forEach { activate(Work(it).work, it.at) }
        }

        override fun afterReplication() {
            snapshots += pool.metrics()
            super.afterReplication()
        }

        inner class Work(
            private val spec: Attempt,
        ) : Entity() {
            val work =
                process {
                    val result = with(pool) { acquire() }
                    outcomes[spec.label] = result.outcome
                    waits[spec.label] = result.waitMs
                    result.allocation?.let { allocation ->
                        acquiredAt[spec.label] = time
                        delay(spec.duration)
                        release(allocation)
                        spec.capacityAfterRelease?.let(pool::changeCapacity)
                    }
                    completedAt[spec.label] = time
                }
        }
    }
}
