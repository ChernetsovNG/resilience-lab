package resiliencelab.core.ir

/** Repetition order; parallel copies join in their declared order. */
enum class RepeatMode { SEQUENTIAL, PARALLEL }

/** Number and scheduling mode of copies of one step. */
data class RepeatConfig(
    val count: Int,
    val mode: RepeatMode,
)

/** Whether a failed cache GET falls through to the source. */
enum class CacheErrorPolicy { SOURCE, FAIL }

/** Exact cache storage configuration; null prefill means an empty cache. */
data class CacheSettings(
    val capacity: Int,
    val ttlMs: Double,
    val ttlJitter: Double,
    val keySpaces: List<CacheKeySpace>,
    val prefillKeys: Int = 0,
)

/** Independent key identity and popularity; ttlMs already includes the cache default. */
data class CacheKeySpace(
    val id: String,
    val keys: Int,
    val zipf: Double,
    val ttlMs: Double,
)

/** Depth-first traversal, pruning a filtered step together with its descendants. */
fun List<ServiceStep>.walk(requestClass: String? = null): Sequence<ServiceStep> =
    sequence {
        val pending = ArrayDeque<Iterator<ServiceStep>>()
        pending.addLast(this@walk.iterator())
        while (pending.isNotEmpty()) {
            val iterator = pending.last()
            if (!iterator.hasNext()) {
                pending.removeLast()
                continue
            }
            val step = iterator.next()
            if (requestClass != null && step.classes?.let { requestClass !in it } == true) continue
            yield(step)
            val children =
                when (step) {
                    is ServiceStep.CacheRead -> step.onMiss
                    is ServiceStep.Parallel -> step.branches.flatten()
                    else -> emptyList()
                }
            if (children.isNotEmpty()) pending.addLast(children.iterator())
        }
    }

/** Connection references include cache GETs and calls inside miss handlers and parallel branches. */
fun List<ServiceStep>.connectionPaths(requestClass: String? = null): Sequence<String> =
    walk(requestClass).mapNotNull {
        when (it) {
            is ServiceStep.Call -> it.edge
            is ServiceStep.CacheRead -> it.edge
            else -> null
        }
    }

/** Rebind every connection when a service scenario is expanded into numbered replicas. */
internal fun List<ServiceStep>.mapConnections(transform: (String) -> String): List<ServiceStep> =
    map { step ->
        when (step) {
            is ServiceStep.Process -> step
            is ServiceStep.Call -> step.copy(edge = transform(step.edge))
            is ServiceStep.CacheRead -> step.copy(edge = transform(step.edge), onMiss = step.onMiss.mapConnections(transform))
            is ServiceStep.Parallel -> step.copy(branches = step.branches.map { it.mapConnections(transform) })
        }
    }
