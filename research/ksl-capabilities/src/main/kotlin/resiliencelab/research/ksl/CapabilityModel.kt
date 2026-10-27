package resiliencelab.research.ksl

import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.entity.Signal
import ksl.modeling.variable.TimeSeriesPeriodData
import ksl.modeling.variable.TimeSeriesResponse
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamIfc
import java.nio.ByteBuffer
import java.security.MessageDigest

/** Research configuration, deliberately separate from the application's scenario contract. */
data class Workload(
    val blocks: Int = 500,
    val requests: Int = 50_000,
    val blocking: Boolean = false,
    val series: Boolean = false,
    val traceEvery: Int = 0,
    val windows: Int = 100,
    val randomDurations: Boolean = true,
    val arrivalInterval: Double = 5.0 / (blocks / 5),
    val observationEnd: Double = requests * arrivalInterval,
    val capacity: Int = 4,
    val pre: Double = 0.25,
    val db: Double = 0.75,
    val childA: Double = 1.0,
    val childB: Double = 0.5,
    val childDb: Double = 2.0,
    val post: Double = 0.25,
    val timeout: Double? = 1.5,
) {
    init {
        require(blocks > 0 && blocks % 5 == 0)
        require(requests > 0 && capacity > 0 && windows > 0 && traceEvery >= 0)
        require(arrivalInterval >= 0.0 && arrivalInterval.isFinite())
        require(observationEnd > 0.0 && observationEnd.isFinite())
        require(listOf(pre, db, childA, childB, childDb, post).all { it >= 0.0 && it.isFinite() })
        require(timeout == null || (timeout >= 0.0 && timeout.isFinite()))
    }
}

/** IDs belong to the request cohort, independent of KSL's global QObject counter. */
data class TraceRow(val request: Int, val node: String, val action: String, val time: Double)

/**
 * A flat graph expanded from identical five-resource subsystems. All queues, process
 * suspension, resource allocation and event ordering are owned by KSL, not a new DES engine.
 */
class CapabilityModel(parent: Model, val workload: Workload) : ProcessModel(parent, "workload") {
    val eventsExecuted: Long get() = executive.numEventsExecuted
    private val joinSignal = Signal(this, "join")
    private val subsystems = List(workload.blocks / 5) { Subsystem(it) }
    val resources: List<ResourceWithQ> = subsystems.flatMap { it.resources }
    val trace = mutableListOf<TraceRow>()
    // Mix request IDs before selection: ordinal % rate aliases round-robin subsystem routing.
    private val sampled = if (workload.traceEvery > 0) BooleanArray(workload.requests) { ordinal ->
        var hash = ordinal
        hash = (hash xor (hash ushr 16)) * 0x7feb352d
        hash = (hash xor (hash ushr 15)) * 0x846ca68b.toInt()
        hash = hash xor (hash ushr 16)
        (hash.toLong() and 0xffffffffL) % workload.traceEvery == 0L
    } else BooleanArray(0)
    val clientEnd = DoubleArray(workload.requests)
    val childEnd = DoubleArray(workload.requests * 2)
    val timedOut = BooleanArray(workload.requests)
    var clientsCompleted = 0
        private set
    var childrenCompleted = 0
        private set
    var lateChildren = 0
        private set
    var joinResumptions = 0
        private set
    private var nextRequest = 0

    private val timeSeries = if (workload.series) {
        TimeSeriesResponse(
            this,
            periodLength = workload.observationEnd / workload.windows,
            numPeriods = workload.windows,
            responses = resources.flatMap { listOf(it.numBusyUnits, it.waitingQ.numInQ) }.toSet(),
            name = "windows",
        )
    } else null

    private inner class Subsystem(val index: Int) {
        val workers = ResourceWithQ(this@CapabilityModel, "s$index.workers", workload.capacity)
        val connections = ResourceWithQ(this@CapabilityModel, "s$index.connections", workload.capacity)
        val a = ResourceWithQ(this@CapabilityModel, "s$index.a", workload.capacity)
        val b = ResourceWithQ(this@CapabilityModel, "s$index.b", workload.capacity)
        val bConnections = ResourceWithQ(this@CapabilityModel, "s$index.bConnections", workload.capacity)
        val resources = listOf(workers, connections, a, b, bConnections)
        // Allocate every stream before Model.simulate positions the replication substreams.
        val streams: List<RNStreamIfc> = List(6) { streamProvider.rnStream(index * 6 + it + 1) }

        fun duration(base: Double, stream: Int): Double =
            if (workload.randomDurations) base * (0.5 + streams[stream].randU01()) else base
    }

    override fun initialize() {
        schedule(this::arrival, 0.0)
    }

    private fun arrival(event: KSLEvent<Nothing>) {
        val request = Request(nextRequest++)
        record(request.ordinal, "s${request.subsystem.index}", "arrival")
        activate(request.run)
        if (nextRequest < workload.requests) schedule(this::arrival, workload.arrivalInterval)
    }

    private fun record(request: Int, node: String, action: String) {
        if (sampled.isNotEmpty() && sampled[request]) {
            trace.add(TraceRow(request, node, action, time))
        }
    }

    private inner class Request(val ordinal: Int) : Entity() {
        val subsystem = subsystems[ordinal % subsystems.size]
        private var remaining = 2
        private var closed = false

        fun childCompleted(branch: Int) {
            childEnd[2 * ordinal + branch] = time
            childrenCompleted++
            if (closed && timedOut[ordinal]) lateChildren++
            remaining--
            if (remaining == 0 && workload.timeout != null) finishJoin(false)
        }

        private fun finishJoin(timeout: Boolean) {
            if (closed) return
            // Signal schedules a resumption: close the gate BEFORE signalling to avoid double resume.
            closed = true
            timedOut[ordinal] = timeout
            record(ordinal, "s${subsystem.index}", if (timeout) "timeout" else "all_replies")
            joinSignal.signal(this)
        }

        val run = process("request") {
            val s = subsystem
            record(ordinal, s.workers.name, "queue")
            var worker = seize(s.workers)
            record(ordinal, s.workers.name, "acquire")
            delay(s.duration(workload.pre, 0))
            if (!workload.blocking) {
                release(worker)
                record(ordinal, s.workers.name, "release")
            }
            record(ordinal, s.connections.name, "queue")
            val connection = seize(s.connections)
            record(ordinal, s.connections.name, "acquire")
            delay(s.duration(workload.db, 1))
            release(connection)
            record(ordinal, s.connections.name, "release")

            val a = Child(this@Request, 0)
            val b = Child(this@Request, 1)
            activate(a.run)
            activate(b.run)
            if (workload.timeout == null) {
                blockUntilAllCompleted(setOf(a.run, b.run))
                closed = true
                record(ordinal, "s${s.index}", "all_replies")
            } else {
                // Completion at the deadline wins. The timer does not terminate either child.
                schedule({ _: KSLEvent<Nothing> -> finishJoin(true) }, workload.timeout, priority = KSLEvent.LOW_PRIORITY)
                waitFor(joinSignal)
            }
            joinResumptions++
            if (!workload.blocking) {
                record(ordinal, s.workers.name, "queue")
                worker = seize(s.workers)
                record(ordinal, s.workers.name, "acquire")
            }
            delay(s.duration(workload.post, 5))
            release(worker)
            record(ordinal, s.workers.name, "release")
            clientEnd[ordinal] = time
            clientsCompleted++
            record(ordinal, "s${s.index}", "client_end")
        }
    }

    private inner class Child(val caller: CapabilityModel.Request, val branch: Int) : Entity() {
        val run = process(if (branch == 0) "child_a" else "child_b") {
            val s = caller.subsystem
            val resource = if (branch == 0) s.a else s.b
            record(caller.ordinal, resource.name, "queue")
            val allocation = seize(resource)
            record(caller.ordinal, resource.name, "acquire")
            delay(s.duration(if (branch == 0) workload.childA else workload.childB, branch + 2))
            if (branch == 1) {
                record(caller.ordinal, s.bConnections.name, "queue")
                val connection = seize(s.bConnections)
                record(caller.ordinal, s.bConnections.name, "acquire")
                delay(s.duration(workload.childDb, 4))
                release(connection)
                record(caller.ordinal, s.bConnections.name, "release")
            }
            release(allocation)
            record(caller.ordinal, resource.name, "release")
            caller.childCompleted(branch)
        }
    }

    fun seriesRows(): List<TimeSeriesPeriodData> = timeSeries?.allTimeSeriesPeriodDataAsList().orEmpty()

    fun verifyDrained() {
        check(clientsCompleted == workload.requests && childrenCompleted == workload.requests * 2)
        check(joinResumptions == workload.requests)
        check(resources.all { it.numBusy == 0 && it.waitingQ.isEmpty })
    }

    /** Exact bitwise fingerprint of every client outcome and both downstream completion times. */
    fun semanticHash(): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = ByteBuffer.allocate(8)
        fun add(value: Long) { bytes.clear(); bytes.putLong(value); digest.update(bytes.array()) }
        clientEnd.forEach { add(it.toBits()) }
        childEnd.forEach { add(it.toBits()) }
        timedOut.forEach { digest.update(if (it) 1.toByte() else 0.toByte()) }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
