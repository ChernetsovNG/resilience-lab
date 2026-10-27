package resiliencelab.research.streams

import java.nio.file.Path
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.ResourceWithQ
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.utilities.io.OutputDirectory
import kotlin.time.Duration.Companion.minutes

/** Independent one-server queues; unrelated blocks cannot affect each other's outcomes. */
data class ProbeBlock(val path: List<String>, val meanService: Double = 0.7)

/** Every sample and completion is recorded as raw Double bits, indexed by semantic identities. */
data class ProbeResult(
    val samples: Map<StreamKey, List<Long>>,
    val completions: Map<List<String>, List<Long>>,
    val successes: Map<List<String>, List<Boolean>>,
)

internal val roles = listOf("arrivals", "processing", "outcome")
internal fun keys(seed: Long, replication: Long, blocks: List<ProbeBlock>): List<StreamKey> =
    blocks.flatMap { block -> roles.map { StreamKey(seed, replication, block.path, it) } }

/** Runs a fresh KSL Model for one logical replication, with externally owned addressed streams. */
fun runProbe(plan: StreamPlan, seed: Long, replication: Long, blocks: List<ProbeBlock>,
             requests: Int, output: Path): ProbeResult {
    require(requests > 0 && blocks.isNotEmpty())
    require(blocks.all { it.meanService.isFinite() && it.meanService > 0 })
    val streams = plan.open(keys(seed, replication, blocks))
    val model = Model("probe", output, autoCSVReports = false)
    model.outputDirectory = OutputDirectory(output, autoCreateOutFile = false)
    model.numberOfReplications = 1
    model.lengthOfReplication = Double.POSITIVE_INFINITY
    model.resetStartStreamOption = false
    model.advanceNextSubStreamOption = false
    model.garbageCollectAfterReplicationFlag = false
    model.maximumAllowedExecutionTimePerReplication = 1.minutes
    val sampled = streams.keys.associateWith { mutableListOf<Long>() }
    val finished = blocks.associate { it.path to LongArray(requests) }
    val successes = blocks.associate { it.path to BooleanArray(requests) }
    var completed = 0
    val process = object : ProcessModel(model, "queues") {
        inner class Node(val block: ProbeBlock, index: Int, owner: ProcessModel) {
            val server = ResourceWithQ(owner, "server-$index", 1)
            var submitted = 0

            fun sample(role: String): Double {
                val key = StreamKey(seed, replication, block.path, role)
                val stream = streams.getValue(key)
                val value = if (role == "outcome") stream.randU01() else stream.rExponential(1.0)
                sampled.getValue(key).add(value.toBits())
                return value
            }

            fun arrival(event: KSLEvent<Nothing>) {
                val ordinal = submitted++
                val request = object : Entity() {
                    val run = process {
                        val allocation = seize(server)
                        val duration = sample("processing") * block.meanService
                        successes.getValue(block.path)[ordinal] = sample("outcome") < 0.9
                        delay(duration)
                        release(allocation)
                        finished.getValue(block.path)[ordinal] = time.toBits()
                        completed++
                    }
                }
                activate(request.run)
                if (submitted < requests) schedule(this::arrival, sample("arrivals"))
            }
        }
        val nodes = blocks.mapIndexed { index, block -> Node(block, index, this) }
        override fun initialize() {
            // Stable tie order is independent of source allocation and hierarchy traversal.
            for (node in nodes.sortedBy { it.block.path.joinToString("/") { id ->
                id.replace("~", "~0").replace("/", "~1")
            } }) schedule(node::arrival, node.sample("arrivals"))
        }
        fun verifyDrained() {
            check(completed == blocks.size * requests) { "Incomplete probe" }
            check(nodes.all { it.server.numBusy == 0 && it.server.waitingQ.isEmpty })
        }
    }
    try {
        model.simulate()
        process.verifyDrained()
        return ProbeResult(sampled.mapValues { it.value.toList() },
            finished.mapValues { it.value.toList() }, successes.mapValues { it.value.toList() })
    } finally {
        model.outputDirectory.close()
    }
}
