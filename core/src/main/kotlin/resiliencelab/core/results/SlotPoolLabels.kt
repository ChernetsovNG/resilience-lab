package resiliencelab.core.results

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import resiliencelab.core.compiler.CoreMessage
import resiliencelab.core.ir.GraphIr

/** Structured resource name, translated at display time with an English fallback for CLI and unknown catalogs. */
@Serializable
data class SlotPoolLabel(
    val code: String,
    val message: String,
    val args: Map<String, JsonPrimitive>,
)

/** Resource names and downstream ordering from the effective graph of one variant point. */
object SlotPoolLabels {
    internal fun label(
        node: String,
        slot: String,
        type: String = "service",
        from: String = node,
        to: String = node,
    ): SlotPoolLabel {
        val contract =
            when (slot) {
                "pool" -> CoreMessage.RESULT_SLOT_POOL
                "clientConnections" -> CoreMessage.RESULT_SLOT_CLIENTS
                "serverConnections" -> CoreMessage.RESULT_SLOT_SERVERS
                else -> if (type == "database") CoreMessage.RESULT_SLOT_DATABASE else CoreMessage.RESULT_SLOT_HANDLERS
            }
        val args =
            if (slot == "pool") {
                mapOf("from" to JsonPrimitive(from), "to" to JsonPrimitive(to))
            } else {
                mapOf("element" to JsonPrimitive(node))
            }
        val message = args.entries.fold(contract.template) { text, (key, value) -> text.replace("{$key}", value.content) }
        return SlotPoolLabel(contract.code, message, contract.args(args))
    }

    internal fun from(graph: GraphIr): Map<String, Map<String, SlotPoolLabel>> =
        buildMap {
            graph.services.forEach { service ->
                val slots = if (service.pooler == null) listOf("handlers") else listOf("clientConnections", "serverConnections")
                put(service.path, slots.associateWith { label(service.path, it, service.type) })
            }
            graph.calls.filter { it.pool != null }.forEach { call ->
                put(call.path, mapOf("pool" to label(call.path, "pool", from = call.from, to = call.to)))
            }
        }

    internal fun positions(graph: GraphIr): Map<String, Int> {
        val positions = graph.topologicalPaths.withIndex().associate { it.value to 2 * it.index }
        return positions + graph.calls.associate { it.path to (positions.getValue(it.from) + 1) }
    }
}
