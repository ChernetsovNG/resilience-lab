package resiliencelab.core.catalog

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Stage 1 catalog: a client, blocking services, the client request and synchronous calls (stage 1 design §3.1). */
object Stage1Catalog {
    private val typeAssumptions =
        mapOf(
            "client" to
                listOf(
                    "Requests arrive as an open Poisson stream; each original request has an absolute end-to-end deadline.",
                    "After the deadline the client stops waiting, but admitted work continues.",
                ),
            "service" to
                listOf(
                    "A handler is allocated once and held through local processing, all downstream attempts, and backoff; " +
                        "retries do not re-enter the caller queue.",
                    "An upstream timeout or deadline does not release downstream handlers or remove admitted work.",
                ),
            "request" to
                listOf("Client requests enter the first service without network delay, per-attempt timeout, or retries."),
            "call" to
                listOf(
                    "A timeout stops the caller from waiting; it does not cancel downstream work, " +
                        "which remains as orphaned work and continues consuming resources.",
                    "Late responses are discarded after timeout or deadline.",
                    "Cancellation does not propagate along the call chain.",
                ),
        )

    val catalog: Catalog =
        Catalog(
            schemaVersion = 1,
            types =
                listOf(client(), service(), request(), call()).map { type ->
                    type.copy(params = type.params.map(::withUnits), assumptions = typeAssumptions.getValue(type.id))
                },
            assumptions =
                listOf(
                    "Summary metrics use the cohort of original requests arriving during the measurement interval; " +
                        "their outcomes and caused attempts include run-out.",
                    "Time series use event-time windows covering warmup and measurement; run-out is excluded from series windows.",
                    "Latency quantiles use the ddsketch-bitwise6-rational-v1 profile with KSL interpolation; " +
                        "representation error is at most 0.78125% in the tested 0.001–60000 ms range.",
                    "Means over independent replications use Student 95% confidence intervals; " +
                        "interval bounds are not clipped to physical metric ranges.",
                ),
        )

    /** Quantity parameters list the units [Quantities] accepts for their dimension (ADR 0001, items 1 and 6). */
    private fun withUnits(param: ParamDescriptor): ParamDescriptor =
        param.copy(units = param.dimension?.let(Quantities::unitsOf).orEmpty(), fields = param.fields.map(::withUnits))

    private fun client() =
        TypeDescriptor(
            id = "client",
            outputs = Stage1Outputs.client,
            version = 1,
            category = TypeCategory.BLOCK,
            title = "Client",
            description = "Open Poisson stream of original requests with an end-to-end deadline.",
            ports = listOf(PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    ParamDescriptor(
                        name = "rate",
                        kind = ParamKind.QUANTITY,
                        title = "Arrival rate",
                        description = "Mean rate of original requests.",
                        required = true,
                        dimension = Dimension.RATE,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "deadline",
                        kind = ParamKind.QUANTITY,
                        title = "Deadline",
                        description = "End-to-end deadline of each original request.",
                        required = true,
                        dimension = Dimension.DURATION,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                ),
        )

    private fun service() =
        TypeDescriptor(
            id = "service",
            outputs = Stage1Outputs.service,
            version = 1,
            category = TypeCategory.BLOCK,
            title = "Service",
            description = "Blocking service: a handler is held through local work, downstream calls and backoff.",
            ports = listOf(PortDescriptor("in", PortDirection.IN), PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    ParamDescriptor(
                        name = "handlers",
                        kind = ParamKind.INTEGER,
                        title = "Handlers",
                        description = "Concurrent handlers.",
                        required = true,
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "queue",
                        kind = ParamKind.INTEGER,
                        title = "Queue capacity",
                        description = "Waiting places in the FIFO queue; zero disables queueing.",
                        default = JsonPrimitive(0),
                        minimum = 0.0,
                        sweepable = true,
                    ),
                    distribution(
                        name = "processing",
                        title = "Processing time",
                        description = "Local processing time of one attempt.",
                        default = null,
                    ),
                    ParamDescriptor(
                        name = "failureRate",
                        kind = ParamKind.QUANTITY,
                        title = "Failure rate",
                        description = "Probability that one local attempt fails.",
                        default = JsonPrimitive("0%"),
                        dimension = Dimension.PROBABILITY,
                        minimum = 0.0,
                        maximum = 1.0,
                        sweepable = true,
                    ),
                ),
        )

    private fun request() =
        TypeDescriptor(
            id = "request",
            outputs = Stage1Outputs.request,
            version = 1,
            category = TypeCategory.CONNECTION,
            title = "Request",
            description = "Delivers original requests from the client to the entry service without delay or retries.",
            connects = ConnectionRule("client", "service"),
        )

    private fun call() =
        TypeDescriptor(
            id = "call",
            outputs = Stage1Outputs.call,
            version = 1,
            category = TypeCategory.CONNECTION,
            title = "Call",
            description = "Synchronous call with a per-attempt timeout, retries and backoff on the caller side.",
            connects = ConnectionRule("service", "service"),
            params =
                listOf(
                    distribution(
                        name = "network",
                        title = "Network delay",
                        description = "One-way network delay, drawn separately for the request and the response.",
                        default =
                            buildJsonObject {
                                put("kind", "fixed")
                                put("mean", "0ms")
                            },
                    ),
                    ParamDescriptor(
                        name = "timeout",
                        kind = ParamKind.QUANTITY,
                        title = "Timeout",
                        description = "Per-attempt timeout, also bounded by the remaining deadline.",
                        required = true,
                        dimension = Dimension.DURATION,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "attempts",
                        kind = ParamKind.INTEGER,
                        title = "Attempts",
                        description = "Maximum attempts including the first one.",
                        default = JsonPrimitive(1),
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "backoff",
                        kind = ParamKind.OBJECT,
                        title = "Backoff",
                        description = "Delay between attempts.",
                        default = buildJsonObject { put("kind", "none") },
                        fields =
                            listOf(
                                ParamDescriptor(
                                    name = "kind",
                                    kind = ParamKind.CHOICE,
                                    title = "Kind",
                                    description = "Backoff policy.",
                                    required = true,
                                    options = listOf("none", "fixed", "exponential-full-jitter"),
                                ),
                                ParamDescriptor(
                                    name = "base",
                                    kind = ParamKind.QUANTITY,
                                    title = "Base delay",
                                    description = "Delay after the first failed attempt before jitter.",
                                    default = JsonPrimitive("0ms"),
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                    sweepable = true,
                                ),
                                ParamDescriptor(
                                    name = "max",
                                    kind = ParamKind.QUANTITY,
                                    title = "Maximum delay",
                                    description = "Upper bound of one backoff delay.",
                                    default = JsonPrimitive("0ms"),
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                ),
                                ParamDescriptor(
                                    name = "multiplier",
                                    kind = ParamKind.NUMBER,
                                    title = "Multiplier",
                                    description = "Growth factor of exponential backoff.",
                                    default = JsonPrimitive(2),
                                    exclusiveMinimum = 0.0,
                                ),
                            ),
                    ),
                ),
        )

    private fun distribution(
        name: String,
        title: String,
        description: String,
        default: JsonElement?,
    ) = ParamDescriptor(
        name = name,
        kind = ParamKind.OBJECT,
        title = title,
        description = description,
        required = default == null,
        default = default,
        fields =
            listOf(
                ParamDescriptor(
                    name = "kind",
                    kind = ParamKind.CHOICE,
                    title = "Distribution",
                    description = "Distribution of the duration.",
                    required = true,
                    options = listOf("fixed", "exponential", "lognormal"),
                ),
                ParamDescriptor(
                    name = "mean",
                    kind = ParamKind.QUANTITY,
                    title = "Mean",
                    description = "Mean duration.",
                    required = true,
                    dimension = Dimension.DURATION,
                    minimum = 0.0,
                    sweepable = true,
                ),
                ParamDescriptor(
                    name = "stdDev",
                    kind = ParamKind.QUANTITY,
                    title = "Standard deviation",
                    description = "Required for lognormal only.",
                    dimension = Dimension.DURATION,
                    exclusiveMinimum = 0.0,
                ),
            ),
    )
}
