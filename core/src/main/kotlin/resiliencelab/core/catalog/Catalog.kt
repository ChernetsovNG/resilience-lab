package resiliencelab.core.catalog

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Whether a type is drawn as a block or as a connection between blocks. */
@Serializable
enum class TypeCategory {
    BLOCK,
    CONNECTION,
}

/** Direction of a block port. */
@Serializable
enum class PortDirection {
    IN,
    OUT,
}

/** Value kinds of catalog parameters. */
@Serializable
enum class ParamKind {
    STRING,
    INTEGER,
    NUMBER,
    QUANTITY,
    CHOICE,
    OBJECT,
    ARRAY,
}

/** A named port of a block type. */
@Serializable
data class PortDescriptor(
    val id: String,
    val direction: PortDirection,
)

/** Block types a connection type may join, from its source to its target. */
@Serializable
data class ConnectionRule(
    val fromTypes: List<String>,
    val toTypes: List<String>,
)

/** Applies only when [field], a sibling in the same object, has one of [values], including its catalog default. */
@Serializable
data class ParamApplicability(
    val field: String,
    val values: List<String>,
)

/**
 * One parameter of a type. Ranges of [ParamKind.QUANTITY] are in canonical units of [dimension], and [units] lists the
 * units a document may write with their scales, so UI checks ranges as the core does; [default] is used when a
 * document omits the parameter. [initial] is written explicitly when creating an element; readers never apply it.
 * A null [appliesWhen] means the parameter is always applicable; otherwise its sibling condition controls visibility.
 */
@Serializable
data class ParamDescriptor(
    val name: String,
    val kind: ParamKind,
    val title: String,
    val description: String,
    val required: Boolean = false,
    val default: JsonElement? = null,
    val initial: JsonElement? = default,
    val dimension: Dimension? = null,
    val units: List<QuantityUnit> = emptyList(),
    val minimum: Double? = null,
    val exclusiveMinimum: Double? = null,
    val maximum: Double? = null,
    val options: List<String> = emptyList(),
    val fields: List<ParamDescriptor> = emptyList(),
    val sweepable: Boolean = false,
    val appliesWhen: ParamApplicability? = null,
)

/** A computable block or connection type; the single source for palette, forms, checks and CLI help (ADR 0001). */
@Serializable
data class TypeDescriptor(
    val id: String,
    val version: Int,
    val category: TypeCategory,
    val title: String,
    val description: String,
    val assumptions: List<String> = emptyList(),
    val ports: List<PortDescriptor> = emptyList(),
    val connects: ConnectionRule? = null,
    val params: List<ParamDescriptor> = emptyList(),
    val outputs: List<OutputDescriptor> = emptyList(),
)

/** Versioned set of computable types and shared model and measurement assumptions. */
@Serializable
data class Catalog(
    val schemaVersion: Int,
    val types: List<TypeDescriptor>,
    val assumptions: List<String> = emptyList(),
) {
    fun type(id: String): TypeDescriptor? = types.firstOrNull { it.id == id }
}
