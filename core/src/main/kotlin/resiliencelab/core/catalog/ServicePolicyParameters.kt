package resiliencelab.core.catalog

import kotlinx.serialization.json.JsonPrimitive

/** Service policies are absent by default; enabling an object supplies its field defaults. */
internal object ServicePolicyParameters {
    val parameters =
        listOf(
            ParamDescriptor(
                "rateLimit",
                ParamKind.OBJECT,
                "Rate limit",
                "Per-instance token bucket before the handler queue. Rejections occupy no handler; probes bypass the bucket.",
                fields =
                    listOf(
                        ParamDescriptor(
                            "rate",
                            ParamKind.QUANTITY,
                            "Token rate",
                            "Tokens replenished per second, up to the burst capacity. Zero permits only the initial burst.",
                            default = JsonPrimitive("100/s"),
                            dimension = Dimension.RATE,
                            minimum = 0.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "burst",
                            ParamKind.INTEGER,
                            "Burst capacity",
                            "Maximum tokens; the bucket starts full at each replication.",
                            default = JsonPrimitive(10),
                            minimum = 1.0,
                            sweepable = true,
                        ),
                    ),
            ),
            ParamDescriptor(
                "healthCheck",
                ParamKind.OBJECT,
                "Readiness check",
                "Probes share the handler queue and processing capacity. All routers skip an instance while it is not ready.",
                fields =
                    listOf(
                        ParamDescriptor(
                            "interval",
                            ParamKind.QUANTITY,
                            "Probe interval",
                            "Minimum time between probe starts; the first probe starts after this interval.",
                            default = JsonPrimitive("10s"),
                            dimension = Dimension.DURATION,
                            exclusiveMinimum = 0.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "timeout",
                            ParamKind.QUANTITY,
                            "Probe timeout",
                            "Maximum wait for a probe result, including queueing. Admitted processing continues after timeout.",
                            default = JsonPrimitive("1s"),
                            dimension = Dimension.DURATION,
                            exclusiveMinimum = 0.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "unhealthyThreshold",
                            ParamKind.INTEGER,
                            "Unhealthy threshold",
                            "Consecutive failed probes required to mark the initially ready instance not ready.",
                            default = JsonPrimitive(3),
                            minimum = 1.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "healthyThreshold",
                            ParamKind.INTEGER,
                            "Healthy threshold",
                            "Consecutive successful probes required to restore readiness.",
                            default = JsonPrimitive(1),
                            minimum = 1.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "processing",
                            ParamKind.QUANTITY,
                            "Probe processing time",
                            "Local handler time, affected by processing delay faults, without running the request scenario or network.",
                            default = JsonPrimitive("1ms"),
                            dimension = Dimension.DURATION,
                            minimum = 0.0,
                            sweepable = true,
                        ),
                    ),
            ),
        )
}
