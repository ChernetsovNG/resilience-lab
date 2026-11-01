package resiliencelab.core.catalog

import kotlinx.serialization.json.JsonPrimitive

/** The same optional policy belongs to an explicit router or to the generated router of a call's replica group. */
internal object OutlierDetectionParameters {
    val parameter =
        ParamDescriptor(
            "outlierDetection",
            ParamKind.OBJECT,
            "Outlier detection",
            "Directs new attempts away from failing instances toward the remaining targets. The router temporarily excludes targets after consecutive failures; state is shared by all callers.",
            fields =
                listOf(
                    ParamDescriptor(
                        "consecutiveFailures",
                        ParamKind.INTEGER,
                        "Consecutive failures",
                        "Target failures required for ejection; a successful attempt resets the streak.",
                        default = JsonPrimitive(5),
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        "baseEjection",
                        ParamKind.QUANTITY,
                        "Base ejection time",
                        "Time excluded on the first ejection; multiplied by the target's ejection number thereafter.",
                        default = JsonPrimitive("30s"),
                        dimension = Dimension.DURATION,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        "maxEjected",
                        ParamKind.QUANTITY,
                        "Maximum ejected share",
                        "Maximum fraction of distinct targets excluded at once, rounded down; at least one target remains.",
                        default = JsonPrimitive("50%"),
                        dimension = Dimension.PROBABILITY,
                        minimum = 0.0,
                        maximum = 1.0,
                        sweepable = true,
                    ),
                ),
        )
}
