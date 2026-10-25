package io.github.chernetsovng.resiliencelab.core.simulation

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.Model
import ksl.simulation.ModelElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BoundedRequestQTest {
    @Test
    fun `idle zero-wait service accepts an attempt without leaving a queued request`() {
        val rig = simulate(
            waitingCapacity = 0,
            holderReleaseTimes = emptyList(),
            attempts = listOf(AttemptSpec("idle", arrivalTime = 0.0)),
        )

        assertEquals(mapOf("idle" to 0.0), rig.admissionTimes)
        assertTrue(rig.rejectionTimes.isEmpty())
        assertEquals(0, rig.queueSizeAfterAdmission.getValue("idle"))
        assertEquals(0, rig.maxObservedWaitingQSize)
        assertEquals(1.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `occupied zero-wait rejection rolls back and later idle work proceeds`() {
        val rig = simulate(
            waitingCapacity = 0,
            attempts = listOf(
                AttemptSpec("rejected", arrivalTime = 1.0),
                AttemptSpec("later", arrivalTime = 12.0),
            ),
        )

        assertEquals(listOf(0.0), rig.holderAdmissionTimes)
        assertEquals(mapOf("later" to 12.0), rig.admissionTimes)
        assertTrue("rejected" !in rig.admissionTimes)
        assertEquals(mapOf("rejected" to 1.0), rig.rejectionTimes)
        assertEquals(listOf(1), rig.resourceBusyAtRejection)
        assertEquals(listOf(0), rig.queueSizeAtRejection)
        assertEquals(0, rig.maxObservedWaitingQSize)
        assertEquals(2.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `one request waits and the next is rejected when waiting capacity is one`() {
        val rig = simulate(
            waitingCapacity = 1,
            attempts = listOf(
                AttemptSpec("waiting", arrivalTime = 1.0),
                AttemptSpec("overflow", arrivalTime = 2.0),
            ),
        )

        assertEquals(mapOf("waiting" to 10.0), rig.admissionTimes)
        assertEquals(mapOf("overflow" to 2.0), rig.rejectionTimes)
        assertEquals(listOf(1), rig.queueSizeAtRejection)
        assertEquals(1, rig.maxObservedWaitingQSize)
        assertEquals(2.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `simultaneous arrivals are admitted FIFO up to waiting capacity`() {
        val rig = simulate(
            waitingCapacity = 2,
            attempts = listOf(
                AttemptSpec("first", arrivalTime = 1.0),
                AttemptSpec("second", arrivalTime = 1.0),
                AttemptSpec("overflow", arrivalTime = 1.0),
            ),
        )

        assertEquals(mapOf("first" to 10.0, "second" to 11.0), rig.admissionTimes)
        assertEquals(mapOf("overflow" to 1.0), rig.rejectionTimes)
        assertEquals(listOf(2), rig.queueSizeAtRejection)
        assertEquals(2, rig.maxObservedWaitingQSize)
        assertEquals(3.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `available capacity does not bypass a full queue while a request waits`() {
        val rig = simulate(
            waitingCapacity = 1,
            resourceCapacity = 2,
            holderReleaseTimes = listOf(10.0, 20.0),
            attempts = listOf(
                AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                AttemptSpec("one-unit", arrivalTime = 11.0, amount = 1),
            ),
        )

        assertEquals(mapOf("two-units" to 20.0), rig.admissionTimes)
        assertEquals(mapOf("one-unit" to 11.0), rig.rejectionTimes)
        assertEquals(listOf(true), rig.resourceHasSpareCapacityAtRejection)
        assertEquals(listOf(1), rig.queueSizeAtRejection)
        assertEquals(1, rig.maxObservedWaitingQSize)
        assertEquals(3.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `later fitting arrival waits behind oversized head with spare waiting capacity`() {
        val rig = simulate(
            waitingCapacity = 2,
            resourceCapacity = 2,
            holderReleaseTimes = listOf(10.0, 20.0),
            attempts = listOf(
                AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                AttemptSpec("one-unit", arrivalTime = 11.0, amount = 1),
            ),
        )

        assertEquals(mapOf("two-units" to 20.0, "one-unit" to 21.0), rig.admissionTimes)
        assertTrue(rig.rejectionTimes.isEmpty())
        assertEquals(2, rig.maxObservedWaitingQSize)
        assertEquals(4.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `release does not bypass oversized head with spare waiting capacity`() {
        val rig = simulate(
            waitingCapacity = 2,
            resourceCapacity = 2,
            holderReleaseTimes = listOf(10.0, 20.0),
            attempts = listOf(
                AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                AttemptSpec("one-unit", arrivalTime = 2.0, amount = 1),
            ),
        )

        assertEquals(mapOf("two-units" to 20.0, "one-unit" to 21.0), rig.admissionTimes)
        assertTrue(rig.rejectionTimes.isEmpty())
        assertEquals(2, rig.maxObservedWaitingQSize)
        assertEquals(4.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `dequeued head allocates before a larger later request`() {
        val rig = simulate(
            waitingCapacity = 2,
            resourceCapacity = 3,
            holderReleaseTimes = listOf(10.0, 20.0),
            attempts = listOf(
                AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                AttemptSpec("three-units", arrivalTime = 2.0, amount = 3),
            ),
        )

        assertEquals(mapOf("two-units" to 10.0, "three-units" to 20.0), rig.admissionTimes)
        assertTrue(rig.rejectionTimes.isEmpty())
        assertEquals(2, rig.maxObservedWaitingQSize)
        assertEquals(4.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    @Test
    fun `single release wakes head and fitting successor in FIFO order`() {
        val rig = simulate(
            waitingCapacity = 2,
            resourceCapacity = 3,
            holderReleaseTimes = listOf(10.0),
            holderAmount = 3,
            attempts = listOf(
                AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                AttemptSpec("one-unit", arrivalTime = 2.0, amount = 1),
            ),
        )

        assertEquals(mapOf("two-units" to 10.0, "one-unit" to 10.0), rig.admissionTimes)
        assertEquals(listOf("two-units", "one-unit"), rig.admissionTimes.keys.toList())
        assertTrue(rig.rejectionTimes.isEmpty())
        assertEquals(2, rig.maxObservedWaitingQSize)
        assertEquals(3.0, rig.queue.timeInQ.withinReplicationStatistic.count, 0.0)
    }

    private fun simulate(
        waitingCapacity: Int,
        resourceCapacity: Int = 1,
        holderReleaseTimes: List<Double> = listOf(10.0),
        holderAmount: Int = 1,
        attempts: List<AttemptSpec>,
    ): QueueRig {
        val model = Model("BoundedRequestQTest", autoCSVReports = false)
        val rig = QueueRig(model, waitingCapacity, resourceCapacity, holderReleaseTimes, holderAmount, attempts)
        model.numberOfReplications = 1
        model.lengthOfReplication = 100.0
        model.simulate()
        return rig
    }

    private data class AttemptSpec(
        val label: String,
        val arrivalTime: Double,
        val amount: Int = 1,
    )

    private class QueueRig(
        parent: ModelElement,
        waitingCapacity: Int,
        resourceCapacity: Int,
        private val holderReleaseTimes: List<Double>,
        private val holderAmount: Int,
        private val attempts: List<AttemptSpec>,
    ) : ProcessModel(parent, null) {
        val resource: ResourceWithQ

        val queue = BoundedRequestQ(
            parent = this,
            name = "service:queue",
            waitingCapacity = waitingCapacity,
            resourceProvider = { resource },
        )
        val admissionTimes = mutableMapOf<String, Double>()
        val rejectionTimes = mutableMapOf<String, Double>()
        val holderAdmissionTimes = mutableListOf<Double>()
        val queueSizeAfterAdmission = mutableMapOf<String, Int>()
        val queueSizeAtRejection = mutableListOf<Int>()
        val resourceBusyAtRejection = mutableListOf<Int>()
        val resourceHasSpareCapacityAtRejection = mutableListOf<Boolean>()
        var maxObservedWaitingQSize = 0
            private set

        init {
            resource = FifoResourceWithQ(
                parent = this,
                name = "service",
                capacity = resourceCapacity,
                queue = queue,
            )
            queue.addQueueListener(object : QueueListenerIfc<ProcessModel.Entity.Request> {
                override fun update(
                    status: Queue.Status,
                    queue: Queue<ProcessModel.Entity.Request>,
                    qObject: ProcessModel.Entity.Request?,
                ) {
                    if (status != Queue.Status.ENQUEUED || qObject == null) return
                    val requestWillWait = queue.size > 1 || !resource.canAllocate(qObject.amountRequested)
                    if (requestWillWait) {
                        maxObservedWaitingQSize = maxOf(maxObservedWaitingQSize, queue.size)
                    }
                }
            })
        }

        override fun initialize() {
            admissionTimes.clear()
            rejectionTimes.clear()
            holderAdmissionTimes.clear()
            queueSizeAfterAdmission.clear()
            queueSizeAtRejection.clear()
            resourceBusyAtRejection.clear()
            resourceHasSpareCapacityAtRejection.clear()
            maxObservedWaitingQSize = 0
            holderReleaseTimes.forEach { releaseAt ->
                activate(Holder(releaseAt).work)
            }
            attempts.forEach { attempt ->
                activate(Attempt(attempt).work, attempt.arrivalTime)
            }
        }

        inner class Holder(private val releaseAt: Double) : Entity() {
            val work = process {
                val allocation = seize(resource, amountNeeded = holderAmount)
                holderAdmissionTimes += time
                delay(releaseAt)
                release(allocation)
            }
        }

        inner class Attempt(private val spec: AttemptSpec) : Entity() {
            val work = process {
                try {
                    val allocation = seize(resource, amountNeeded = spec.amount)
                    admissionTimes[spec.label] = time
                    queueSizeAfterAdmission[spec.label] = resource.waitingQ.size
                    delay(1.0)
                    release(allocation)
                } catch (exception: QueueFullException) {
                    rejectionTimes[spec.label] = time
                    queueSizeAtRejection += resource.waitingQ.size
                    resourceBusyAtRejection += resource.numBusy
                    resourceHasSpareCapacityAtRejection += resource.capacity - resource.numBusy >= spec.amount
                }
            }
        }
    }
}
