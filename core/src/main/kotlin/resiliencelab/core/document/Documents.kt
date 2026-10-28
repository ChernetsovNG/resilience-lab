package resiliencelab.core.document

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `*.model.json`: blocks by id and connections between them (ADR 0005, stage 1 design §3.2). */
@Serializable
data class ModelFile(
    val schemaVersion: Int,
    val description: String? = null,
    val notes: String? = null,
    val blocks: Map<String, BlockInstance>,
    val connections: List<ConnectionInstance> = emptyList(),
)

/** One block: catalog type, parameter values as written in the document and explanations (ADR 0005, item 5). */
@Serializable
data class BlockInstance(
    val type: String,
    val params: JsonObject = JsonObject(emptyMap()),
    val description: String? = null,
    val notes: String? = null,
)

/** One connection from a source block to a target block. */
@Serializable
data class ConnectionInstance(
    val id: String,
    val type: String,
    val from: String,
    val to: String,
    val params: JsonObject = JsonObject(emptyMap()),
    val description: String? = null,
    val notes: String? = null,
)

/** `*.layout.json`: canvas positions by block path. */
@Serializable
data class LayoutFile(
    val schemaVersion: Int,
    val positions: Map<String, Position> = emptyMap(),
)

/** Top-left corner of a block on the canvas. */
@Serializable
data class Position(
    val x: Double,
    val y: Double,
)

/** `*.experiment.json`: the model reference, run settings, faults and variants as path overrides (ADR 0002). */
@Serializable
data class ExperimentFile(
    val schemaVersion: Int,
    val description: String? = null,
    val notes: String? = null,
    val modelRef: String,
    val layoutRef: String? = null,
    val execution: ExecutionSettings,
    val faults: List<Fault> = emptyList(),
    val variants: List<Variant>,
    val grid: List<GridAxis> = emptyList(),
)

/** An ordered parameter axis; values retain document units and are checked by the compiler. */
@Serializable
data class GridAxis(
    val path: String,
    val values: List<JsonElement>,
)

/** Replications, measurement window and seed; durations are quantities such as `1s`. */
@Serializable
data class ExecutionSettings(
    val replications: Int,
    val warmup: String,
    val measurement: String,
    val seed: Long,
    val maxRealTime: String = "30s",
    val window: String? = null,
)

/** A degradation of the [target] service while local processing starts within [from, to). */
@Serializable
data class Fault(
    val target: String,
    val from: String,
    val to: String,
    val processingMultiplier: Double? = null,
    val failureRate: String? = null,
)

/** A variant: parameter overrides keyed by `blockOrConnectionId.param[.field]`. */
@Serializable
data class Variant(
    val id: String,
    val label: String? = null,
    val overrides: Map<String, JsonElement> = emptyMap(),
)
