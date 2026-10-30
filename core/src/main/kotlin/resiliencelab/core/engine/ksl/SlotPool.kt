package resiliencelab.core.engine.ksl

import ksl.modeling.entity.Allocation
import ksl.modeling.entity.AllocationListenerIfc
import ksl.modeling.entity.KSLProcessBuilder
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.KSLEvent
import ksl.simulation.ModelElement

/** The four admission outcomes; only [IMMEDIATE] and [WAITED] carry an allocation. */
internal enum class SlotAcquisitionOutcome { IMMEDIATE, WAITED, QUEUE_FULL, WAIT_LIMIT }

/** [waitMs] is zero for immediate admission/full rejection and the actual wait otherwise. */
internal data class SlotAcquisition(
    val outcome: SlotAcquisitionOutcome,
    val allocation: Allocation? = null,
    val waitMs: Double = 0.0,
)

/**
 * Integrals cover replication start through the snapshot time, in slot/queue units times milliseconds.
 * [waitCount] counts requests that entered a real wait; [totalWaitMs] sums finished waits, including
 * wait-limit rejection. Immediate acquisitions and full-queue rejections do not count as waits.
 */
internal data class SlotPoolMetrics(
    val busyIntegralMs: Double,
    val queueIntegralMs: Double,
    val capacityIntegralMs: Double,
    val waitCount: Long,
    val totalWaitMs: Double,
    val queueFullCount: Long,
    val waitLimitCount: Long,
)

/**
 * A bounded FIFO pool of single-unit KSL allocations. The caller owns holding/releasing allocations.
 * A null wait limit waits indefinitely; a zero limit permits only allocation at the arrival instant.
 * Capacity changes never preempt work, and growth serves waiting requests using KSL's allocation order.
 * All metrics reset at each replication; the legacy callbacks retain their queue/allocation ordering.
 * Queues use stable admission ranks to preserve FIFO when capacity loss cancels a native wake.
 * Native timeInQ observes each queue residence; [metrics] counts the full logical wait once.
 */
internal class SlotPool(
    parent: ModelElement,
    name: String,
    private val initialCapacity: Int,
    queueCapacity: Int,
    private val waitLimitMs: Double? = null,
    private val onAdmitted: (ProcessModel.Entity) -> Unit = {},
    private val onQueueLengthChanged: (Int) -> Unit = {},
    private val onBusyChanged: (Int) -> Unit = {},
) : ModelElement(parent, "$name:slots") {
    init {
        require(initialCapacity >= 0)
        require(queueCapacity >= 0)
        require(waitLimitMs == null || (waitLimitMs.isFinite() && waitLimitMs >= 0.0))
    }

    val resource: FifoResourceWithQ
    val queue: RequestQ = BoundedRequestQ(parent, "$name:queue", queueCapacity) { resource }
    private val waitedEntities = mutableSetOf<ProcessModel.Entity>()
    private val acquiringEntities = mutableSetOf<ProcessModel.Entity>()
    private val waitingSince = mutableMapOf<ProcessModel.Entity.Request, Double>()
    private var nextAdmissionRank = 0
    private var capacityRevision = 0L
    private var requeueingRequest: ProcessModel.Entity.Request? = null
    private var lastTime = 0.0
    private var busy = 0
    private var queued = 0
    private var capacity = initialCapacity
    private var busyIntegral = 0.0
    private var queueIntegral = 0.0
    private var capacityIntegral = 0.0
    private var waits = 0L
    private var totalWait = 0.0
    private var fullRejections = 0L
    private var waitRejections = 0L

    init {
        resource = FifoResourceWithQ(parent, name, maxOf(1, initialCapacity), queue, deferReleaseNotifications = waitLimitMs != null)
        resource.initialCapacity = initialCapacity
        queue.initialDiscipline = Queue.Discipline.RANKED
        queue.currentDiscipline = Queue.Discipline.RANKED
        queue.addQueueListener(
            object : QueueListenerIfc<ProcessModel.Entity.Request> {
                override fun update(
                    status: Queue.Status,
                    queue: Queue<ProcessModel.Entity.Request>,
                    qObject: ProcessModel.Entity.Request?,
                ) {
                    if (qObject != null && qObject === requeueingRequest) return
                    if (status == Queue.Status.ENQUEUED && qObject != null) {
                        assignAdmissionRank(qObject)
                    }
                    advance()
                    queued = queue.size
                    onQueueLengthChanged(queue.size)
                    if (status == Queue.Status.ENQUEUED && qObject != null) {
                        if (queue.size > 1 || !resource.canAllocate(1)) {
                            waitingSince[qObject] = time
                            waitedEntities += qObject.entity
                            waits++
                        }
                        onAdmitted(qObject.entity)
                        if (qObject in waitingSince && qObject.entity in acquiringEntities) {
                            throw Waiting(qObject)
                        }
                    } else if (qObject != null) {
                        waitingSince.remove(qObject)?.let { totalWait += time - it }
                    }
                }
            },
        )
        resource.addAllocationListener(
            object : AllocationListenerIfc {
                override fun allocate(allocation: Allocation) = changed()

                override fun deallocate(allocation: Allocation) = changed()

                private fun changed() {
                    advance()
                    busy = resource.numBusy
                    onBusyChanged(busy)
                }
            },
        )
    }

    override fun initialize() {
        waitedEntities.clear()
        acquiringEntities.clear()
        waitingSince.clear()
        nextAdmissionRank = 0
        capacityRevision = 0L
        requeueingRequest = null
        lastTime = 0.0
        busy = 0
        queued = 0
        capacity = initialCapacity
        busyIntegral = 0.0
        queueIntegral = 0.0
        capacityIntegral = 0.0
        waits = 0L
        totalWait = 0.0
        fullRejections = 0L
        waitRejections = 0L
    }

    /**
     * Requests one slot, optionally shortening this acquisition's wait for a caller deadline.
     * Allocations/releases retain native KSL priorities, ahead of wait expiry.
     */
    suspend fun KSLProcessBuilder.acquire(waitLimitMs: Double? = this@SlotPool.waitLimitMs): SlotAcquisition {
        val startedAt = time
        acquiringEntities += entity
        return try {
            val allocation =
                try {
                    seize(resource)
                } catch (waiting: Waiting) {
                    awaitSlot(waiting.request, waitLimitMs)
                }
            val waitedMs = time - startedAt
            if (allocation == null) {
                waitRejections++
                SlotAcquisition(SlotAcquisitionOutcome.WAIT_LIMIT, waitMs = waitedMs)
            } else {
                SlotAcquisition(
                    if (entity in waitedEntities) SlotAcquisitionOutcome.WAITED else SlotAcquisitionOutcome.IMMEDIATE,
                    allocation,
                    waitedMs,
                )
            }
        } catch (_: QueueFullException) {
            fullRejections++
            SlotAcquisition(SlotAcquisitionOutcome.QUEUE_FULL)
        } finally {
            acquiringEntities -= entity
            waitedEntities -= entity
        }
    }

    // Native seize creates its Request internally. As with bounded-queue rejection, a listener
    // hands control back before native suspension, so FIFO recovery and timed waiting can use public KSL APIs.
    private class Waiting(
        val request: ProcessModel.Entity.Request,
    ) : RuntimeException()

    @Suppress("DEPRECATION") // KSL's native seize also uses general suspension for resource queue wakeups.
    private suspend fun KSLProcessBuilder.awaitSlot(
        request: ProcessModel.Entity.Request,
        waitLimitMs: Double?,
    ): Allocation? {
        var expired = false
        var observedCapacityRevision = capacityRevision
        val expiry =
            waitLimitMs?.let { limitMs ->
                schedule(
                    EventActionIfc<Nothing> {
                        if (request.queue === queue) {
                            expired = true
                            queue.remove(request)
                            entity.resumeProcess()
                        }
                    },
                    limitMs,
                    priority = KSLEvent.DEFAULT_PRIORITY + 1,
                )
            }
        try {
            suspend()
            while (!expired) {
                if (observedCapacityRevision != capacityRevision) {
                    // Public removal clears this request's native promise/resume-pending flag.
                    // Its original admission rank restores FIFO without disturbing other wakeups.
                    requeueAfterCapacityLoss(request)
                    observedCapacityRevision = capacityRevision
                    if (queue.peekNext() === request && resource.canAllocate(1)) break
                    if (resource.capacity > resource.numBusy) resource.retrySlotQueue()
                } else if (queue.peekNext() === request && resource.capacity > resource.numBusy) {
                    break
                }
                suspend()
            }
            if (expired) return null
            queue.remove(request)
            return resource.allocate(entity, 1, queue)
        } finally {
            if (expiry?.isScheduled == true) expiry.cancel = true
            if (request.queue === queue) queue.remove(request, waitStats = false)
        }
    }

    private fun assignAdmissionRank(request: ProcessModel.Entity.Request) {
        if (queue.size == 1) nextAdmissionRank = 0
        if (nextAdmissionRank == Int.MAX_VALUE) {
            // Rebase only active ranks before overflow; no bound on total acquisitions is added.
            val earlier = queue.immutableList.filter { it !== request }
            earlier.forEachIndexed { rank, queuedRequest -> queuedRequest.priority = rank }
            nextAdmissionRank = earlier.size
        }
        request.priority = nextAdmissionRank++
    }

    private fun requeueAfterCapacityLoss(request: ProcessModel.Entity.Request) {
        requeueingRequest = request
        try {
            // Native timeInQ records each queue residence. Logical wait metrics retain the original
            // waitingSince entry, original expiry event, and a single wait/admission count.
            queue.remove(request)
            queue.enqueue(request)
        } finally {
            requeueingRequest = null
        }
    }

    /** Sets the capacity immediately, including zero or below busy; occupied units finish normally. */
    fun changeCapacity(capacity: Int) {
        require(capacity >= 0)
        advance()
        if (capacity < resource.capacity) capacityRevision++
        resource.changeSlotCapacity(capacity)
        this.capacity = capacity
    }

    /** A snapshot through the current simulation time, without changing event scheduling. */
    fun metrics(): SlotPoolMetrics {
        advance()
        return SlotPoolMetrics(busyIntegral, queueIntegral, capacityIntegral, waits, totalWait, fullRejections, waitRejections)
    }

    private fun advance() {
        val elapsed = time - lastTime
        busyIntegral += elapsed * busy
        queueIntegral += elapsed * queued
        capacityIntegral += elapsed * capacity
        lastTime = time
    }
}
