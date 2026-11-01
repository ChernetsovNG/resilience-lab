package resiliencelab.core.catalog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive

/** Optional objects stay absent on new calls; their fields supply initial values when a policy is enabled. */
internal object CallPolicyParameters {
    val parameters =
        listOf(
            ParamDescriptor(
                "circuitBreaker",
                ParamKind.OBJECT,
                "Circuit breaker",
                "Stops sending attempts to a failing dependency so it has time to recover. When open, it rejects attempts at the caller; each calling instance tracks its own completed attempts.",
                fields =
                    listOf(
                        ParamDescriptor(
                            "failureRate",
                            ParamKind.QUANTITY,
                            "Failure threshold",
                            "Open when the failure share reaches this threshold after the minimum number of completed attempts.",
                            default = JsonPrimitive("50%"),
                            dimension = Dimension.PROBABILITY,
                            minimum = 0.0,
                            maximum = 1.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "minimumCalls",
                            ParamKind.INTEGER,
                            "Minimum calls",
                            "Completed attempts required before evaluating the failure share; no greater than the window size.",
                            default = JsonPrimitive(10),
                            minimum = 1.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "window",
                            ParamKind.INTEGER,
                            "Window size",
                            "Number of recent completed dependency-call attempts used by the closed circuit breaker to calculate the failure share. Attempts rejected by this circuit breaker are not included.",
                            default = JsonPrimitive(20),
                            minimum = 1.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "openDuration",
                            ParamKind.QUANTITY,
                            "Open duration",
                            "Time the circuit breaker stays open before allowing probe attempts to the dependency. Attempts rejected by the circuit breaker use no connection pool, network or target work.",
                            default = JsonPrimitive("5s"),
                            dimension = Dimension.DURATION,
                            exclusiveMinimum = 0.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "halfOpenCalls",
                            ParamKind.INTEGER,
                            "Half-open calls",
                            "Maximum number of probe attempts. Their completed failure share decides whether to close or reopen.",
                            default = JsonPrimitive(3),
                            minimum = 1.0,
                            sweepable = true,
                        ),
                    ),
            ),
            ParamDescriptor(
                "retryBudget",
                ParamKind.OBJECT,
                "Retry budget",
                "Limits the extra load that retries send to a failing dependency. Retries are bounded by a share of first attempts plus a minimum allowance over a rolling time window.",
                fields =
                    listOf(
                        ParamDescriptor(
                            "ratio",
                            ParamKind.QUANTITY,
                            "Retry ratio",
                            "Maximum retries per first attempt within the window.",
                            default = JsonPrimitive("20%"),
                            dimension = Dimension.PROBABILITY,
                            minimum = 0.0,
                            maximum = 1.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "minPerSecond",
                            ParamKind.QUANTITY,
                            "Minimum retries per second",
                            "Additional allowance multiplied by the window duration; it is available even with no first attempts.",
                            default = JsonPrimitive("10/s"),
                            dimension = Dimension.RATE,
                            minimum = 0.0,
                            sweepable = true,
                        ),
                        ParamDescriptor(
                            "window",
                            ParamKind.QUANTITY,
                            "Budget window",
                            "Age after which first attempts and retries leave the budget.",
                            default = JsonPrimitive("10s"),
                            dimension = Dimension.DURATION,
                            exclusiveMinimum = 0.0,
                            sweepable = true,
                        ),
                    ),
            ),
            ParamDescriptor(
                "fallback",
                ParamKind.OBJECT,
                "Fallback",
                "Lets the scenario continue when a dependency call ultimately fails. Replaces selected final failure reasons after all attempts; successful originals with a fallback count as degraded.",
                fields =
                    listOf(
                        ParamDescriptor(
                            "on",
                            ParamKind.ARRAY,
                            "Failure reasons",
                            "Final failure reasons replaced by the fallback; deadline is excluded.",
                            default = Json.parseToJsonElement("""["circuitOpen"]"""),
                            options =
                                listOf(
                                    "error",
                                    "unavailable",
                                    "timeout",
                                    "queueFull",
                                    "waitLimit",
                                    "circuitOpen",
                                    "rateLimited",
                                    "noRoute",
                                    "noReadyTarget",
                                ),
                        ),
                        ParamDescriptor(
                            "processing",
                            ParamKind.QUANTITY,
                            "Fallback processing time",
                            "Time spent on the calling handler before continuing the scenario, bounded by the original deadline.",
                            default = JsonPrimitive("1ms"),
                            dimension = Dimension.DURATION,
                            minimum = 0.0,
                            sweepable = true,
                        ),
                    ),
            ),
        )
}
