package resiliencelab.core.experiment

import resiliencelab.core.ir.GraphIr
import resiliencelab.core.results.ConnectionWindow
import resiliencelab.core.results.ConnectionWindowMetrics
import resiliencelab.core.results.NodeWindow
import resiliencelab.core.results.WindowMetrics

/** Derives group statistics from the same instance observations without scheduling simulation events. */
object ReplicaGroups {
    /** Numeric suffix segments are compiler instance identities; generated router outputs are excluded. */
    fun membership(graph: GraphIr): List<ReplicaGroup> {
        fun groups(
            paths: List<Pair<String, List<String>>>,
            kind: ReplicaGroupKind,
        ): List<ReplicaGroup> =
            paths
                .mapNotNull { (id, segments) ->
                    val number =
                        segments
                            .lastOrNull()
                            ?.takeIf { it.matches(Regex("#[1-9][0-9]*")) }
                            ?.drop(1)
                            ?.toIntOrNull()
                    if (number == null) {
                        null
                    } else {
                        val base = segments.dropLast(1).joinToString("/")
                        base to ReplicaMember(id, number)
                    }
                }.groupBy({ it.first }, { it.second })
                .filterValues { it.size > 1 }
                .toSortedMap()
                .map { (id, members) ->
                    ReplicaGroup(id, kind, members.sortedBy { it.replica })
                }
        return groups(graph.services.map { it.path to it.pathSegments }, ReplicaGroupKind.NODE) +
            groups(graph.calls.map { it.path to it.pathSegments }, ReplicaGroupKind.CONNECTION)
    }

    internal fun latency(values: List<LatencyStatistics>): LatencyStatistics =
        LatencyAccumulator(context = "replica group latency").also { accumulator -> values.forEach(accumulator::merge) }.snapshot()

    /** Extrema use each member's own capacity and the group's shared observation interval. */
    internal fun slots(
        group: ReplicaGroup,
        durationMs: Double,
        rows: (String) -> Map<String, SlotPoolMetrics>,
    ): Map<String, SlotPoolMetrics> =
        MetricsAggregator.sumSlotPools(group.instances.map { rows(it.id) }).mapValues { (set, sum) ->
            val values = group.instances.sortedBy { it.replica }.mapNotNull { member -> rows(member.id)[set]?.let { member.replica to it } }
            val utilizations =
                values.mapNotNull { (replica, value) ->
                    if (value.capacityIntegralMs <= 0.0) null else replica to value.busyIntegralMs / value.capacityIntegralMs
                }
            val queues = values.map { (replica, value) -> replica to value.queueIntegralMs / durationMs }
            val maxUtilization = utilizations.maxByOrNull { it.second }
            val maxQueue = queues.maxBy { it.second }
            sum.copy(
                replicaExtrema =
                    ReplicaSlotExtrema(
                        utilizations.minOfOrNull { it.second },
                        maxUtilization?.second,
                        maxUtilization?.first,
                        queues.minOf { it.second },
                        maxQueue.second,
                        maxQueue.first,
                    ),
            )
        }

    /** Adds event-time group rows; original instance rows are returned untouched by callers. */
    fun nodeWindows(
        groups: List<ReplicaGroup>,
        nodes: List<NodeWindow>,
        clientId: String? = null,
    ): List<NodeWindow> {
        val rows = nodes.associate { it.id to it.metrics }
        return groups.filter { it.kind == ReplicaGroupKind.NODE }.map { group ->
            val values = group.instances.map { rows.getValue(it.id) }
            val first = values.first()
            NodeWindow(
                group.id,
                WindowMetrics(
                    startMs = first.startMs,
                    durationMs = first.durationMs,
                    originalArrivals = values.sumOf { it.originalArrivals },
                    clientOriginalArrivals = clientId?.let { rows.getValue(it).originalArrivals },
                    offeredAttempts = values.sumOf { it.offeredAttempts },
                    admittedAttempts = values.sumOf { it.admittedAttempts },
                    successes = values.sumOf { it.successes },
                    failures = values.sumOf { it.failures },
                    timeouts = values.sumOf { it.timeouts },
                    retries = values.sumOf { it.retries },
                    latency = latency(values.map { it.latency }),
                    slotPools = slots(group, first.durationMs) { rows.getValue(it).slotPools },
                ),
            )
        }
    }

    /** Copied call rows retain response-only latency semantics and shared window denominators. */
    fun connectionWindows(
        groups: List<ReplicaGroup>,
        connections: List<ConnectionWindow>,
    ): List<ConnectionWindow> {
        val rows = connections.associate { it.id to it.metrics }
        return groups.filter { it.kind == ReplicaGroupKind.CONNECTION }.map { group ->
            val values = group.instances.map { rows.getValue(it.id) }
            val first = values.first()
            ConnectionWindow(
                group.id,
                ConnectionWindowMetrics(
                    startMs = first.startMs,
                    durationMs = first.durationMs,
                    sentAttempts = values.sumOf { it.sentAttempts },
                    retries = values.sumOf { it.retries },
                    succeeded = values.sumOf { it.succeeded },
                    failed = values.sumOf { it.failed },
                    timeouts = values.sumOf { it.timeouts },
                    orphaned = values.sumOf { it.orphaned },
                    inFlightIntegralMs = values.sumOf { it.inFlightIntegralMs },
                    orphanedIntegralMs = values.sumOf { it.orphanedIntegralMs },
                    backoffIntegralMs = values.sumOf { it.backoffIntegralMs },
                    latency = latency(values.map { it.latency }),
                    slotPools = slots(group, first.durationMs) { rows.getValue(it).slotPools },
                ),
            )
        }
    }

    /** Measurement extrema are computed from full member integrals, never from window maxima. */
    fun replication(
        groups: List<ReplicaGroup>,
        result: ReplicationResult,
    ): ReplicationResult {
        val serviceGroups =
            groups.filter {
                it.kind == ReplicaGroupKind.NODE &&
                    it.instances.all { member ->
                        member.id in result.services
                    }
            }
        val callGroups = groups.filter { it.kind == ReplicaGroupKind.CONNECTION }
        return result.copy(
            groups = groups,
            services =
                result.services +
                    serviceGroups.associate { group ->
                        val values = group.instances.map { result.services.getValue(it.id) }
                        group.id to
                            ServiceMetrics(
                                offeredAttempts = values.sumOf { it.offeredAttempts },
                                admittedAttempts = values.sumOf { it.admittedAttempts },
                                timeouts = values.sumOf { it.timeouts },
                                retries = values.sumOf { it.retries },
                                failures = values.sumOf { it.failures },
                                measurementMs = values.first().measurementMs,
                                // Group queue integrals describe the sum; an instance queue histogram is not a group histogram.
                                queueDurationsMs = emptyMap(),
                                latency = latency(values.map { it.latency }),
                                slotPools = slots(group, values.first().measurementMs) { result.services.getValue(it).slotPools },
                            )
                    },
            connections =
                result.connections +
                    callGroups.associate { group ->
                        val values = group.instances.map { result.connections.getValue(it.id) }
                        group.id to
                            ConnectionMetrics(
                                sentAttempts = values.sumOf { it.sentAttempts },
                                retries = values.sumOf { it.retries },
                                succeeded = values.sumOf { it.succeeded },
                                failed = values.sumOf { it.failed },
                                timeouts = values.sumOf { it.timeouts },
                                orphaned = values.sumOf { it.orphaned },
                                inFlightIntegralMs = values.sumOf { it.inFlightIntegralMs },
                                orphanedIntegralMs = values.sumOf { it.orphanedIntegralMs },
                                backoffIntegralMs = values.sumOf { it.backoffIntegralMs },
                                measurementMs = values.first().measurementMs,
                                latency = latency(values.map { it.latency }),
                                slotPools = slots(group, values.first().measurementMs) { result.connections.getValue(it).slotPools },
                            )
                    },
        )
    }
}
