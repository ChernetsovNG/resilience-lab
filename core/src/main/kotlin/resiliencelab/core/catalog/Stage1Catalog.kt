package resiliencelab.core.catalog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Stage 1 catalog: a client, blocking services, the client request and synchronous calls (stage 1 design §3.1). */
object Stage1Catalog {
    private val typeAssumptions =
        mapOf(
            "client" to
                listOf(
                    "New requests arrive at random times at the configured average rate, independently of earlier " +
                        "completions. Each request has an overall deadline measured from arrival.",
                    "After the deadline the client stops waiting, but admitted work continues.",
                ),
            "service" to
                listOf(
                    "A handler is allocated once and held through local processing, all downstream attempts, and backoff; " +
                        "retries do not re-enter the caller queue.",
                    "An upstream timeout or deadline does not release downstream handlers or remove admitted work.",
                ),
            "database" to
                listOf(
                    "Each query holds one connection until completion; waiting queries use a bounded FIFO queue.",
                    "An upstream timeout does not cancel an admitted query or release its connection.",
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
            "pooler" to
                listOf(
                    "Transaction mode: client connections have no queue; server connections use a FIFO wait timeout.",
                    "The server connection is held through local delay and the outgoing call; the client connection lasts through the reply.",
                    "An upstream timeout does not cancel admitted pooler work.",
                ),
            "router" to listOf("Selection has no queue or delay; a new output is selected for each calling attempt."),
            "route" to listOf("Output weight affects random selection only; timeout and retries belong to the incoming call."),
        )

    val catalog: Catalog =
        Catalog(
            schemaVersion = 7,
            types =
                listOf(client(), service(), request(), call(), router(), route(), database(), pooler()).map { type ->
                    type.copy(params = type.params.map(::withUnits), assumptions = typeAssumptions.getValue(type.id))
                },
            assumptions =
                listOf(
                    "Summary request and attempt metrics follow original requests arriving during measurement and " +
                        "all attempts they cause, including completion after measurement ends. Summary resource values " +
                        "cover only measurement.",
                    "Time series cover warm-up and measurement. Events belong to the windows when they occur; " +
                        "completion after measurement ends is excluded.",
                    "Latency percentiles, such as p95, are estimates from compact summaries of observations. " +
                        "Representation error is at most 0.78125% in the tested 0.001–60000 ms range.",
                    "A 95% confidence interval expresses uncertainty in the mean across independent replications, " +
                        "using Student's t method. Bounds are not clipped to physically possible values.",
                ),
        )

    /**
     * Quantity parameters list the units [Quantities] accepts for their dimension (ADR 0001, items 1 and 6).
     * Nested initial values follow their enclosing object or the first initial array item.
     */
    private fun withUnits(param: ParamDescriptor): ParamDescriptor {
        val fields =
            when (val initial = param.initial) {
                is JsonObject -> initial
                is JsonArray -> initial.firstOrNull() as? JsonObject
                else -> null
            }
        return param.copy(
            units = param.dimension?.let(Quantities::unitsOf).orEmpty(),
            fields = param.fields.map { field -> withUnits(field.copy(initial = fields?.get(field.name) ?: field.initial)) },
        )
    }

    private fun client(): TypeDescriptor {
        val load = loadParameter()
        return TypeDescriptor(
            id = "client",
            outputs = Stage1Outputs.client,
            version = 2,
            category = TypeCategory.BLOCK,
            title = "Client",
            description = "Generates requests at random times at the configured average rate. Each request has an overall deadline.",
            ports = listOf(PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    load,
                    ParamDescriptor(
                        name = "classes",
                        kind = ParamKind.ARRAY,
                        title = "Request classes",
                        description =
                            "Per-class load profiles; use either load or classes. " +
                                "Variants replace the entire list; grids are not supported.",
                        fields =
                            listOf(
                                ParamDescriptor(
                                    "id",
                                    ParamKind.STRING,
                                    "Class id",
                                    "Unique block-style identifier; default is reserved.",
                                    required = true,
                                    initial = JsonPrimitive("read"),
                                ),
                                load.copy(
                                    required = true,
                                    description =
                                        "Average arrival rate for this request type over time, including warm-up; it " +
                                            "changes linearly between points.",
                                ),
                            ),
                    ),
                    ParamDescriptor(
                        name = "deadline",
                        kind = ParamKind.QUANTITY,
                        title = "Deadline",
                        description =
                            "Maximum time from request arrival until the client stops waiting, including all calls, " +
                                "retries and pauses. Initially 10s.",
                        required = true,
                        initial = JsonPrimitive("10s"),
                        dimension = Dimension.DURATION,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                ),
        )
    }

    private fun loadParameter() =
        ParamDescriptor(
            name = "load",
            kind = ParamKind.OBJECT,
            title = "Load profile",
            description =
                "Average request arrival rate over time, including warm-up; it changes linearly between points. " +
                    "Compare profiles in variants. Initially one point at 0s with 10/s.",
            required = false,
            initial = Json.parseToJsonElement("""{"points":[{"time":"0s","rate":"10/s"}]}"""),
            fields =
                listOf(
                    ParamDescriptor(
                        name = "points",
                        kind = ParamKind.ARRAY,
                        title = "Load points",
                        description =
                            "Increasing times with linear interpolation; the nearest rate is held outside the points.",
                        required = true,
                        fields =
                            listOf(
                                ParamDescriptor(
                                    name = "time",
                                    kind = ParamKind.QUANTITY,
                                    title = "Time",
                                    description = "Time from simulation start, including warm-up.",
                                    required = true,
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                ),
                                ParamDescriptor(
                                    name = "rate",
                                    kind = ParamKind.QUANTITY,
                                    title = "Intensity",
                                    description = "Non-negative average request arrival rate.",
                                    required = true,
                                    dimension = Dimension.RATE,
                                    minimum = 0.0,
                                ),
                            ),
                    ),
                ),
        )

    private fun service() =
        TypeDescriptor(
            id = "service",
            outputs =
                Stage1Outputs.service + ServicePolicyOutputs.outputs + OutlierDetectionOutputs.outputs +
                    ReplicaGroupOutputs.outputs("handlers"),
            version = 3,
            category = TypeCategory.BLOCK,
            title = "Service",
            description = "A replica holds a handler while processing a request, waiting for downstream calls and pausing before retries.",
            ports = listOf(PortDescriptor("in", PortDirection.IN), PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    ParamDescriptor(
                        name = "handlers",
                        kind = ParamKind.INTEGER,
                        title = "Handlers",
                        description =
                            "Maximum requests handled at once by each replica, similar to threads, workers or a " +
                                "concurrency limit. A handler stays occupied while waiting for downstream calls and " +
                                "retries. Initially 200.",
                        required = true,
                        initial = JsonPrimitive(200),
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "queue",
                        kind = ParamKind.INTEGER,
                        title = "Queue capacity",
                        description =
                            "Waiting places in the FIFO queue. " +
                                "0 means no queue: when all handlers are busy, an attempt is rejected immediately. Initially 100.",
                        default = JsonPrimitive(0),
                        initial = JsonPrimitive(100),
                        minimum = 0.0,
                        sweepable = true,
                    ),
                    distribution(
                        name = "processing",
                        title = "Processing time",
                        description = "Local processing time of one attempt. Initially exponential with a mean of 10ms.",
                        default = null,
                        initial = Json.parseToJsonElement("""{"kind":"exponential","mean":"10ms"}"""),
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
                    ParamDescriptor(
                        name = "replicas",
                        kind = ParamKind.INTEGER,
                        title = "Replicas",
                        description =
                            "Number of service instances. More replicas distribute incoming requests across " +
                                "independent handler pools.",
                        default = JsonPrimitive(1),
                        minimum = 1.0,
                        sweepable = true,
                    ),
                ) + ServicePolicyParameters.parameters,
        )

    private fun pooler() =
        TypeDescriptor(
            id = "pooler",
            outputs = PoolerOutputs.outputs,
            version = 1,
            category = TypeCategory.BLOCK,
            title = "Transaction pooler",
            description = "Client admission and a bounded-wait server connection pool before one synchronous call.",
            ports = listOf(PortDescriptor("in", PortDirection.IN), PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    ParamDescriptor(
                        name = "maxClientConnections",
                        kind = ParamKind.INTEGER,
                        title = "Maximum client connections",
                        description = "Concurrent client connections; excess attempts are rejected immediately. Initially 1000.",
                        required = true,
                        initial = JsonPrimitive(1000),
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "poolSize",
                        kind = ParamKind.INTEGER,
                        title = "Server pool size",
                        description = "Concurrent server connections held through local delay and the outgoing call. Initially 20.",
                        required = true,
                        initial = JsonPrimitive(20),
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "waitTimeout",
                        kind = ParamKind.QUANTITY,
                        title = "Server connection wait timeout",
                        description =
                            "Maximum FIFO wait for a server connection. " +
                                "0 means no waiting: if no server connection is free, the attempt is rejected immediately. Initially 5s.",
                        required = true,
                        initial = JsonPrimitive("5s"),
                        dimension = Dimension.DURATION,
                        minimum = 0.0,
                        sweepable = true,
                    ),
                    distribution(
                        name = "processing",
                        title = "Pooler delay",
                        description =
                            "Local delay after acquiring a server connection, before the outgoing call. New poolers " +
                                "start with a fixed delay of 0.1ms; if omitted from a document, the delay is fixed at " +
                                "0ms.",
                        default =
                            buildJsonObject {
                                put("kind", "fixed")
                                put("mean", "0ms")
                            },
                        initial = Json.parseToJsonElement("""{"kind":"fixed","mean":"0.1ms"}"""),
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
            connects = ConnectionRule(listOf("client"), listOf("service")),
        )

    private fun call() =
        TypeDescriptor(
            id = "call",
            outputs = Stage1Outputs.call + ReplicaGroupOutputs.outputs("pool"),
            version = 3,
            category = TypeCategory.CONNECTION,
            title = "Call",
            description = "Synchronous call with a per-attempt timeout, retries and backoff on the caller side.",
            connects = ConnectionRule(listOf("service", "pooler"), listOf("service", "router", "database", "pooler")),
            params =
                listOf(
                    distribution(
                        name = "network",
                        title = "Network delay",
                        description = "One-way network delay, drawn separately for the request and the response. Initially fixed at 1ms.",
                        default =
                            buildJsonObject {
                                put("kind", "fixed")
                                put("mean", "0ms")
                            },
                        initial = Json.parseToJsonElement("""{"kind":"fixed","mean":"1ms"}"""),
                    ),
                    ParamDescriptor(
                        name = "timeout",
                        kind = ParamKind.QUANTITY,
                        title = "Timeout",
                        description = "Per-attempt timeout, also bounded by the remaining deadline. Initially 1s.",
                        required = true,
                        initial = JsonPrimitive("1s"),
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
                        name = "balancing",
                        kind = ParamKind.CHOICE,
                        title = "Balancing",
                        description = "Choose how attempts are distributed across the target replicas. The default is round robin.",
                        default = JsonPrimitive("roundRobin"),
                        options = listOf("roundRobin", "random", "leastInFlight"),
                    ),
                    ParamDescriptor(
                        name = "retryTarget",
                        kind = ParamKind.CHOICE,
                        title = "Retry target",
                        description =
                            "Another replica prefers a replica or routing target not yet tried by this request; " +
                                "once all have been tried, any may be reused.",
                        default = JsonPrimitive("any"),
                        options = listOf("any", "other"),
                    ),
                    ParamDescriptor(
                        name = "pool",
                        kind = ParamKind.OBJECT,
                        title = "Connection pool",
                        description = "Connections owned by each calling instance, held until a response or attempt timeout.",
                        fields =
                            listOf(
                                ParamDescriptor(
                                    name = "size",
                                    kind = ParamKind.INTEGER,
                                    title = "Pool size",
                                    description =
                                        "Maximum simultaneous connections for this call on each caller instance. Initially 10 when " +
                                            "the pool is enabled.",
                                    required = true,
                                    initial = JsonPrimitive(10),
                                    minimum = 1.0,
                                    sweepable = true,
                                ),
                                ParamDescriptor(
                                    name = "acquireTimeout",
                                    kind = ParamKind.QUANTITY,
                                    title = "Acquisition timeout",
                                    description =
                                        "Maximum wait for a free connection, also bounded by the remaining deadline. " +
                                            "0 means no waiting: if no connection is free, the attempt fails immediately.",
                                    default = JsonPrimitive("30s"),
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                    sweepable = true,
                                ),
                            ),
                    ),
                    ParamDescriptor(
                        name = "backoff",
                        kind = ParamKind.OBJECT,
                        title = "Backoff",
                        description = "Pause before a retry (backoff). The calling handler remains occupied during the pause.",
                        default = buildJsonObject { put("kind", "none") },
                        fields =
                            listOf(
                                ParamDescriptor(
                                    name = "kind",
                                    kind = ParamKind.CHOICE,
                                    title = "Kind",
                                    description =
                                        "Fixed uses the base delay, capped by the maximum. Exponential pauses choose a random value " +
                                            "from zero to the current limit; the multiplier sets how that limit changes.",
                                    required = true,
                                    options = listOf("none", "fixed", "exponential-full-jitter"),
                                ),
                                ParamDescriptor(
                                    name = "base",
                                    kind = ParamKind.QUANTITY,
                                    title = "Base delay",
                                    description =
                                        "Base pause after the first failed attempt; full jitter chooses a random " +
                                            "pause between zero and the current limit.",
                                    appliesWhen = ParamApplicability("kind", listOf("fixed", "exponential-full-jitter")),
                                    default = JsonPrimitive("0ms"),
                                    initial = JsonPrimitive("10ms"),
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                    sweepable = true,
                                ),
                                ParamDescriptor(
                                    name = "max",
                                    kind = ParamKind.QUANTITY,
                                    title = "Maximum delay",
                                    description = "Upper bound of one backoff delay.",
                                    appliesWhen = ParamApplicability("kind", listOf("fixed", "exponential-full-jitter")),
                                    default = JsonPrimitive("0ms"),
                                    initial = JsonPrimitive("100ms"),
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                ),
                                ParamDescriptor(
                                    name = "multiplier",
                                    kind = ParamKind.NUMBER,
                                    title = "Multiplier",
                                    description = "Growth factor of exponential backoff.",
                                    appliesWhen = ParamApplicability("kind", listOf("exponential-full-jitter")),
                                    default = JsonPrimitive(2),
                                    exclusiveMinimum = 0.0,
                                ),
                            ),
                    ),
                ) + CallPolicyParameters.parameters + OutlierDetectionParameters.parameter,
        )

    private fun router() =
        TypeDescriptor(
            id = "router",
            version = 2,
            category = TypeCategory.BLOCK,
            title = "Router",
            description =
                "Selects a service, database or another router without queueing or delay; " +
                    "outputs are measured on route connections.",
            ports = listOf(PortDescriptor("in", PortDirection.IN), PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    ParamDescriptor(
                        name = "policy",
                        kind = ParamKind.CHOICE,
                        title = "Policy",
                        description = "Round robin, weighted random, or fewest unfinished attempts; ties use route path order.",
                        default = JsonPrimitive("roundRobin"),
                        options = listOf("roundRobin", "random", "leastInFlight"),
                    ),
                ) + OutlierDetectionParameters.parameter,
        )

    private fun route() =
        TypeDescriptor(
            id = "route",
            version = 1,
            category = TypeCategory.CONNECTION,
            title = "Route",
            description = "One router output to a callable block.",
            connects = ConnectionRule(listOf("router"), listOf("service", "router", "database", "pooler")),
            params =
                listOf(
                    ParamDescriptor(
                        name = "weight",
                        kind = ParamKind.NUMBER,
                        title = "Weight",
                        description = "Positive output weight used only by random routing.",
                        default = JsonPrimitive(1),
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                ),
            outputs =
                listOf(
                    OutputDescriptor(
                        id = "sentAttempts",
                        title = "Routed attempts",
                        description =
                            "Attempts selected for this output, including retries. Windows count events when they " +
                                "occur; summary counts follow requests arriving during measurement, including their " +
                                "later attempts.",
                        unit = OutputUnit.REQUESTS,
                        kind = OutputKind.COUNT,
                        calculation = OutputCalculation(OutputCalculationKind.VALUE, "sentAttempts"),
                        summary =
                            OutputSummary(
                                OutputCalculation(OutputCalculationKind.RATIO, "totals.sentAttempts", "replications"),
                                OutputSummarySource.PER_REPLICATION,
                            ),
                        timeline = OutputTimeline("routing", "Routing", 0, 0),
                        inspector = OutputInspector("Routed attempts", 0, chartOrder = 0),
                    ),
                ),
        )

    private fun database() =
        service().let { service ->
            service.copy(
                id = "database",
                version = 1,
                title = "Database",
                description = "Database server with a connection limit and a bounded FIFO query queue; no outgoing calls.",
                ports = listOf(PortDescriptor("in", PortDirection.IN)),
                outputs = Stage1Outputs.database,
                params =
                    service.params.filterNot { it.name in setOf("replicas", "rateLimit", "healthCheck") }.map { param ->
                        when (param.name) {
                            "handlers" ->
                                param.copy(
                                    name = "maxConnections",
                                    initial = JsonPrimitive(100),
                                    title = "Maximum connections",
                                    description = "Maximum concurrent database connections. Initially 100.",
                                )
                            "queue" ->
                                param.copy(
                                    initial = JsonPrimitive(0),
                                    title = "Queue capacity",
                                    description =
                                        "Waiting queries. " +
                                            "0 means no queue: when all connections are busy, a query is rejected immediately. Initially 0.",
                                )
                            "processing" ->
                                param.copy(
                                    initial = Json.parseToJsonElement("""{"kind":"exponential","mean":"5ms"}"""),
                                    title = "Query time",
                                    description = "Execution time of one database query. Initially exponential with a mean of 5ms.",
                                )
                            "failureRate" ->
                                param.copy(
                                    title = "Failure rate",
                                    description = "Probability that one executed query fails.",
                                )
                            else -> param
                        }
                    },
            )
        }

    private fun distribution(
        name: String,
        title: String,
        description: String,
        default: JsonElement?,
        initial: JsonElement? = default,
    ) = ParamDescriptor(
        name = name,
        kind = ParamKind.OBJECT,
        title = title,
        description = description,
        required = default == null,
        default = default,
        initial = initial,
        fields =
            listOf(
                ParamDescriptor(
                    name = "kind",
                    kind = ParamKind.CHOICE,
                    title = "Distribution",
                    description =
                        "Choose fixed for a constant duration, exponential for independent random durations, " +
                            "or lognormal for a long tail of slow operations.",
                    required = true,
                    options = listOf("fixed", "exponential", "lognormal"),
                ),
                ParamDescriptor(
                    name = "mean",
                    kind = ParamKind.QUANTITY,
                    title = "Mean",
                    description = "Use the measured average, not p95 or p99. It sets the scale of the chosen distribution.",
                    required = true,
                    dimension = Dimension.DURATION,
                    minimum = 0.0,
                    sweepable = true,
                ),
                ParamDescriptor(
                    name = "stdDev",
                    kind = ParamKind.QUANTITY,
                    title = "Standard deviation",
                    description = "For lognormal only: use the measured standard deviation. Larger values produce more variation.",
                    appliesWhen = ParamApplicability("kind", listOf("lognormal")),
                    dimension = Dimension.DURATION,
                    exclusiveMinimum = 0.0,
                ),
            ),
    )
}
