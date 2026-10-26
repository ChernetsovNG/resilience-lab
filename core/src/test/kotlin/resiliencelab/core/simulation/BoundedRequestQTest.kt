package resiliencelab.core.simulation

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.Model
import ksl.simulation.ModelElement
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import kotlin.test.Test

class BoundedRequestQTest {
    @Test
    fun `idle zero-wait service accepts an attempt without leaving a queued request`() {
        val rig =
            simulate(
                waitingCapacity = 0,
                holderReleaseTimes = emptyList(),
                attempts = listOf(AttemptSpec("idle", arrivalTime = 0.0)),
            )

        assertThat(rig.admissionTimes).containsExactlyEntriesOf(mapOf("idle" to 0.0))
        assertThat(rig.rejectionTimes).isEmpty()
        assertThat(rig.queueSizeAfterAdmission.getValue("idle")).isZero()
        assertThat(rig.maxObservedWaitingQSize).isZero()
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(1.0, offset(0.0))
    }

    @Test
    fun `occupied zero-wait rejection rolls back and later idle work proceeds`() {
        val rig =
            simulate(
                waitingCapacity = 0,
                attempts =
                    listOf(
                        AttemptSpec("rejected", arrivalTime = 1.0),
                        AttemptSpec("later", arrivalTime = 12.0),
                    ),
            )

        assertThat(rig.holderAdmissionTimes).containsExactly(0.0)
        assertThat(rig.admissionTimes).containsExactlyEntriesOf(mapOf("later" to 12.0))
        assertThat(rig.admissionTimes).doesNotContainKey("rejected")
        assertThat(rig.rejectionTimes).containsExactlyEntriesOf(mapOf("rejected" to 1.0))
        assertThat(rig.resourceBusyAtRejection).containsExactly(1)
        assertThat(rig.queueSizeAtRejection).containsExactly(0)
        assertThat(rig.maxObservedWaitingQSize).isZero()
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(2.0, offset(0.0))
    }

    @Test
    fun `one request waits and the next is rejected when waiting capacity is one`() {
        val rig =
            simulate(
                waitingCapacity = 1,
                attempts =
                    listOf(
                        AttemptSpec("waiting", arrivalTime = 1.0),
                        AttemptSpec("overflow", arrivalTime = 2.0),
                    ),
            )

        assertThat(rig.admissionTimes).containsExactlyEntriesOf(mapOf("waiting" to 10.0))
        assertThat(rig.rejectionTimes).containsExactlyEntriesOf(mapOf("overflow" to 2.0))
        assertThat(rig.queueSizeAtRejection).containsExactly(1)
        assertThat(rig.maxObservedWaitingQSize).isEqualTo(1)
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(2.0, offset(0.0))
    }

    @Test
    fun `simultaneous arrivals are admitted FIFO up to waiting capacity`() {
        val rig =
            simulate(
                waitingCapacity = 2,
                attempts =
                    listOf(
                        AttemptSpec("first", arrivalTime = 1.0),
                        AttemptSpec("second", arrivalTime = 1.0),
                        AttemptSpec("overflow", arrivalTime = 1.0),
                    ),
            )

        assertThat(rig.admissionTimes).containsExactlyEntriesOf(mapOf("first" to 10.0, "second" to 11.0))
        assertThat(rig.rejectionTimes).containsExactlyEntriesOf(mapOf("overflow" to 1.0))
        assertThat(rig.queueSizeAtRejection).containsExactly(2)
        assertThat(rig.maxObservedWaitingQSize).isEqualTo(2)
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(3.0, offset(0.0))
    }

    @Test
    fun `available capacity does not bypass a full queue while a request waits`() {
        val rig =
            simulate(
                waitingCapacity = 1,
                resourceCapacity = 2,
                holderReleaseTimes = listOf(10.0, 20.0),
                attempts =
                    listOf(
                        AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                        AttemptSpec("one-unit", arrivalTime = 11.0, amount = 1),
                    ),
            )

        assertThat(rig.admissionTimes).containsExactlyEntriesOf(mapOf("two-units" to 20.0))
        assertThat(rig.rejectionTimes).containsExactlyEntriesOf(mapOf("one-unit" to 11.0))
        assertThat(rig.resourceHasSpareCapacityAtRejection).containsExactly(true)
        assertThat(rig.queueSizeAtRejection).containsExactly(1)
        assertThat(rig.maxObservedWaitingQSize).isEqualTo(1)
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(3.0, offset(0.0))
    }

    @Test
    fun `later fitting arrival waits behind oversized head with spare waiting capacity`() {
        val rig =
            simulate(
                waitingCapacity = 2,
                resourceCapacity = 2,
                holderReleaseTimes = listOf(10.0, 20.0),
                attempts =
                    listOf(
                        AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                        AttemptSpec("one-unit", arrivalTime = 11.0, amount = 1),
                    ),
            )

        assertThat(rig.admissionTimes)
            .containsExactlyEntriesOf(mapOf("two-units" to 20.0, "one-unit" to 21.0))
        assertThat(rig.rejectionTimes).isEmpty()
        assertThat(rig.maxObservedWaitingQSize).isEqualTo(2)
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(4.0, offset(0.0))
    }

    @Test
    fun `release does not bypass oversized head with spare waiting capacity`() {
        val rig =
            simulate(
                waitingCapacity = 2,
                resourceCapacity = 2,
                holderReleaseTimes = listOf(10.0, 20.0),
                attempts =
                    listOf(
                        AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                        AttemptSpec("one-unit", arrivalTime = 2.0, amount = 1),
                    ),
            )

        assertThat(rig.admissionTimes)
            .containsExactlyEntriesOf(mapOf("two-units" to 20.0, "one-unit" to 21.0))
        assertThat(rig.rejectionTimes).isEmpty()
        assertThat(rig.maxObservedWaitingQSize).isEqualTo(2)
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(4.0, offset(0.0))
    }

    @Test
    fun `dequeued head allocates before a larger later request`() {
        val rig =
            simulate(
                waitingCapacity = 2,
                resourceCapacity = 3,
                holderReleaseTimes = listOf(10.0, 20.0),
                attempts =
                    listOf(
                        AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                        AttemptSpec("three-units", arrivalTime = 2.0, amount = 3),
                    ),
            )

        assertThat(rig.admissionTimes)
            .containsExactlyEntriesOf(mapOf("two-units" to 10.0, "three-units" to 20.0))
        assertThat(rig.rejectionTimes).isEmpty()
        assertThat(rig.maxObservedWaitingQSize).isEqualTo(2)
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(4.0, offset(0.0))
    }

    @Test
    fun `single release wakes head and fitting successor in FIFO order`() {
        val rig =
            simulate(
                waitingCapacity = 2,
                resourceCapacity = 3,
                holderReleaseTimes = listOf(10.0),
                holderAmount = 3,
                attempts =
                    listOf(
                        AttemptSpec("two-units", arrivalTime = 1.0, amount = 2),
                        AttemptSpec("one-unit", arrivalTime = 2.0, amount = 1),
                    ),
            )

        assertThat(rig.admissionTimes)
            .containsExactlyEntriesOf(mapOf("two-units" to 10.0, "one-unit" to 10.0))
        assertThat(rig.admissionTimes.keys).containsExactly("two-units", "one-unit")
        assertThat(rig.rejectionTimes).isEmpty()
        assertThat(rig.maxObservedWaitingQSize).isEqualTo(2)
        assertThat(rig.queue.timeInQ.withinReplicationStatistic.count).isCloseTo(3.0, offset(0.0))
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

        val queue =
            BoundedRequestQ(
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
            resource =
                FifoResourceWithQ(
                    parent = this,
                    name = "service",
                    capacity = resourceCapacity,
                    queue = queue,
                )
            queue.addQueueListener(
                object : QueueListenerIfc<ProcessModel.Entity.Request> {
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
                },
            )
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

        inner class Holder(
            private val releaseAt: Double,
        ) : Entity() {
            val work =
                process {
                    val allocation = seize(resource, amountNeeded = holderAmount)
                    holderAdmissionTimes += time
                    delay(releaseAt)
                    release(allocation)
                }
        }

        inner class Attempt(
            private val spec: AttemptSpec,
        ) : Entity() {
            val work =
                process {
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
