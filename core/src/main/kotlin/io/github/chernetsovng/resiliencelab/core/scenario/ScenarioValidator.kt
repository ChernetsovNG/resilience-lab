package io.github.chernetsovng.resiliencelab.core.scenario

object ScenarioValidator {
    fun validate(document: ExperimentDocument): List<ValidationIssue> {
        val issues = mutableListOf<ValidationIssue>()
        validateExecution(document.execution, issues)
        document.variants.forEachIndexed { index, variant ->
            val prefix = "variants[$index]"
            variant.sweepValue?.let { value ->
                validateFinite(value, "$prefix.sweepValue", issues)
            }
            validateScenario(variant.scenario, "$prefix.scenario", issues)
        }
        return issues
    }

    fun requireValid(document: ExperimentDocument) {
        requireNoIssues(validate(document))
    }

    fun validate(document: SweepDocument): List<ValidationIssue> {
        val issues = mutableListOf<ValidationIssue>()
        validateExecution(document.execution, issues)
        validateScenario(document.baseScenario, "baseScenario", issues)
        validateSweep(document, issues)
        return issues
    }

    fun requireValid(document: SweepDocument) {
        requireNoIssues(validate(document))
    }

    private fun requireNoIssues(errors: List<ValidationIssue>) {
        if (errors.isNotEmpty()) {
            throw ScenarioValidationException(errors)
        }
    }

    private fun validateExecution(execution: Execution, issues: MutableList<ValidationIssue>) {
        if (execution.replications <= 0) {
            issues += ValidationIssue("execution.replications", "must be greater than zero")
        }
        validateFiniteNonNegative(execution.warmupMs, "execution.warmupMs", issues)
        validateFinitePositive(execution.measurementMs, "execution.measurementMs", issues)
        if (execution.maxRealTimeSeconds <= 0L) {
            issues += ValidationIssue("execution.maxRealTimeSeconds", "must be greater than zero")
        }
    }

    private fun validateScenario(
        scenario: Scenario,
        prefix: String,
        issues: MutableList<ValidationIssue>,
    ) {
        if (scenario.services.isEmpty()) {
            issues += ValidationIssue("$prefix.services", "must contain at least one service")
        } else if (scenario.services.none { it.id == scenario.entry }) {
            issues += ValidationIssue("$prefix.entry", "must reference an existing service")
        }

        val duplicateServiceIds = findDuplicates(
            scenario.services.mapIndexed { index, service -> Triple(index, service.id, "$prefix.services[$index].id") },
            issues,
            "Service ID",
        )
        findDuplicates(
            scenario.links.mapIndexed { index, link -> Triple(index, link.id, "$prefix.links[$index].id") },
            issues,
            "Link ID",
        )

        scenario.services.forEachIndexed { index, service ->
            validateService(service, "$prefix.services[$index]", issues)
        }
        scenario.links.forEachIndexed { index, link ->
            validateLink(link, "$prefix.links[$index]", scenario.services, issues)
        }
        validateWorkload(scenario.workload, "$prefix.workload", issues)
        validateDegradation(scenario.degradation, "$prefix.degradation", scenario.services, issues)

        if (scenario.services.isNotEmpty() && duplicateServiceIds.isEmpty()) {
            validateTopology(scenario, prefix, issues)
        }
    }

    private fun findDuplicates(
        declarations: List<Triple<Int, String, String>>,
        issues: MutableList<ValidationIssue>,
        label: String,
    ): Set<String> {
        val seen = mutableSetOf<String>()
        val duplicates = mutableSetOf<String>()
        declarations.forEach { (_, id, path) ->
            if (!seen.add(id)) {
                duplicates += id
                issues += ValidationIssue(path, "$label '$id' is duplicated")
            }
        }
        return duplicates
    }

    private fun validateService(
        service: ServiceSpec,
        prefix: String,
        issues: MutableList<ValidationIssue>,
    ) {
        if (service.handlers <= 0) {
            issues += ValidationIssue("$prefix.handlers", "must be greater than zero")
        }
        if (service.queueCapacity < 0) {
            issues += ValidationIssue("$prefix.queueCapacity", "must be non-negative")
        }
        validateDistribution(service.processing, "$prefix.processing", issues)
        validateFailureRate(service.failureRate, "$prefix.failureRate", issues)
    }

    private fun validateLink(
        link: LinkSpec,
        prefix: String,
        services: List<ServiceSpec>,
        issues: MutableList<ValidationIssue>,
    ) {
        if (services.none { it.id == link.from }) {
            issues += ValidationIssue("$prefix.from", "must reference an existing service")
        }
        if (services.none { it.id == link.to }) {
            issues += ValidationIssue("$prefix.to", "must reference an existing service")
        }
        validateDistribution(link.network, "$prefix.network", issues)
        validateFinitePositive(link.timeoutMs, "$prefix.timeoutMs", issues)
        if (link.maxAttempts <= 0) {
            issues += ValidationIssue("$prefix.maxAttempts", "must be greater than zero")
        }
        validateFiniteNonNegative(link.retry.baseBackoffMs, "$prefix.retry.baseBackoffMs", issues)
        validateFiniteNonNegative(link.retry.maxBackoffMs, "$prefix.retry.maxBackoffMs", issues)
    }

    private fun validateDistribution(
        distribution: DurationDistribution,
        prefix: String,
        issues: MutableList<ValidationIssue>,
    ) {
        val meanPath = "$prefix.meanMs"
        when {
            !distribution.meanMs.isFinite() -> issues += ValidationIssue(meanPath, "must be finite")
            distribution.kind == DistributionKind.FIXED && distribution.meanMs < 0.0 ->
                issues += ValidationIssue(meanPath, "must be non-negative for FIXED")
            distribution.kind != DistributionKind.FIXED && distribution.meanMs <= 0.0 ->
                issues += ValidationIssue(meanPath, "must be greater than zero for ${distribution.kind}")
        }

        val stdDevPath = "$prefix.stdDevMs"
        val stdDev = distribution.stdDevMs
        when {
            stdDev == null && distribution.kind == DistributionKind.LOGNORMAL ->
                issues += ValidationIssue(stdDevPath, "is required for LOGNORMAL")
            stdDev != null && !stdDev.isFinite() -> issues += ValidationIssue(stdDevPath, "must be finite")
            stdDev != null && distribution.kind == DistributionKind.LOGNORMAL && stdDev <= 0.0 ->
                issues += ValidationIssue(stdDevPath, "must be greater than zero for LOGNORMAL")
        }
    }

    private fun validateWorkload(
        workload: WorkloadSpec,
        prefix: String,
        issues: MutableList<ValidationIssue>,
    ) {
        validateFinitePositive(workload.arrivalRate, "$prefix.arrivalRate", issues)
        validateFinitePositive(workload.requestDeadlineMs, "$prefix.requestDeadlineMs", issues)
    }

    private fun validateDegradation(
        degradation: DegradationSpec?,
        prefix: String,
        services: List<ServiceSpec>,
        issues: MutableList<ValidationIssue>,
    ) {
        if (degradation == null) return

        if (services.none { it.id == degradation.serviceId }) {
            issues += ValidationIssue("$prefix.serviceId", "must reference an existing service")
        }
        validateFinite(degradation.startMs, "$prefix.startMs", issues)
        validateFinite(degradation.endMs, "$prefix.endMs", issues)
        if (
            degradation.startMs.isFinite() &&
            degradation.endMs.isFinite() &&
            degradation.startMs >= degradation.endMs
        ) {
            issues += ValidationIssue("$prefix.endMs", "must be greater than startMs")
        }
        validateFinite(degradation.processingMultiplier, "$prefix.processingMultiplier", issues)
        degradation.failureRate?.let { failureRate ->
            validateFailureRate(failureRate, "$prefix.failureRate", issues)
        }
    }

    private fun validateTopology(
        scenario: Scenario,
        prefix: String,
        issues: MutableList<ValidationIssue>,
    ) {
        val serviceIds = scenario.services.map { it.id }.toSet()
        val indexedLinks = scenario.links.withIndex().toList()
        val outgoing = indexedLinks.filter { it.value.from in serviceIds }.groupBy { it.value.from }
        val incoming = indexedLinks.filter { it.value.to in serviceIds }.groupBy { it.value.to }
        val validOutgoing = indexedLinks.filter {
            it.value.from in serviceIds && it.value.to in serviceIds
        }.groupBy { it.value.from }

        outgoing.values.forEach { links ->
            links.drop(1).forEach { link ->
                issues += ValidationIssue(
                    "$prefix.links[${link.index}].from",
                    "service must have at most one outgoing link",
                )
            }
        }
        incoming.values.forEach { links ->
            links.drop(1).forEach { link ->
                issues += ValidationIssue(
                    "$prefix.links[${link.index}].to",
                    "service must have at most one incoming link",
                )
            }
        }

        val states = mutableMapOf<String, Int>()
        fun visit(serviceId: String) {
            states[serviceId] = 1
            validOutgoing[serviceId].orEmpty().forEach { link ->
                when (states[link.value.to]) {
                    1 -> issues += ValidationIssue(
                        "$prefix.links[${link.index}].to",
                        "must not close a cycle",
                    )
                    null -> visit(link.value.to)
                }
            }
            states[serviceId] = 2
        }

        if (scenario.entry in serviceIds) visit(scenario.entry)
        scenario.services.forEach { service ->
            if (service.id !in states) visit(service.id)
        }

        if (scenario.entry in serviceIds) {
            val reachable = mutableSetOf<String>()
            val pending = ArrayDeque<String>()
            pending += scenario.entry
            while (pending.isNotEmpty()) {
                val serviceId = pending.removeFirst()
                if (reachable.add(serviceId)) {
                    validOutgoing[serviceId].orEmpty().forEach { link -> pending += link.value.to }
                }
            }
            scenario.services.forEachIndexed { index, service ->
                if (service.id !in reachable) {
                    issues += ValidationIssue(
                        "$prefix.services[$index].id",
                        "service must be connected to the entry chain",
                    )
                }
            }
        }
    }

    private fun validateSweep(document: SweepDocument, issues: MutableList<ValidationIssue>) {
        when (document.sweep.parameter) {
            SweepParameter.ARRIVAL_RATE -> Unit
            SweepParameter.LINK_TIMEOUT,
            SweepParameter.MAX_ATTEMPTS,
            SweepParameter.BACKOFF_BASE,
            -> validateLinkTarget(document, issues)
            SweepParameter.DEGRADATION_MULTIPLIER -> validateServiceTarget(document, issues)
        }

        if (document.sweep.values.isEmpty()) {
            issues += ValidationIssue("sweep.values", "must not be empty")
        }
        document.sweep.values.forEachIndexed { index, value ->
            validateFinite(value, "sweep.values[$index]", issues)
        }
    }

    private fun validateLinkTarget(document: SweepDocument, issues: MutableList<ValidationIssue>) {
        val linkId = document.sweep.linkId
        if (linkId == null) {
            issues += ValidationIssue("sweep.linkId", "is required for ${document.sweep.parameter}")
        } else if (document.baseScenario.links.none { it.id == linkId }) {
            issues += ValidationIssue("sweep.linkId", "must reference an existing link")
        }
    }

    private fun validateServiceTarget(document: SweepDocument, issues: MutableList<ValidationIssue>) {
        val serviceId = document.sweep.serviceId
        if (serviceId == null) {
            issues += ValidationIssue("sweep.serviceId", "is required for ${document.sweep.parameter}")
        } else if (document.baseScenario.services.none { it.id == serviceId }) {
            issues += ValidationIssue("sweep.serviceId", "must reference an existing service")
        }
    }

    private fun validateFailureRate(
        value: Double,
        path: String,
        issues: MutableList<ValidationIssue>,
    ) {
        when {
            !value.isFinite() -> issues += ValidationIssue(path, "must be finite")
            value !in 0.0..1.0 -> issues += ValidationIssue(path, "must be between 0 and 1")
        }
    }

    private fun validateFinite(
        value: Double,
        path: String,
        issues: MutableList<ValidationIssue>,
    ) {
        if (!value.isFinite()) {
            issues += ValidationIssue(path, "must be finite")
        }
    }

    private fun validateFinitePositive(
        value: Double,
        path: String,
        issues: MutableList<ValidationIssue>,
    ) {
        when {
            !value.isFinite() -> issues += ValidationIssue(path, "must be finite")
            value <= 0.0 -> issues += ValidationIssue(path, "must be greater than zero")
        }
    }

    private fun validateFiniteNonNegative(
        value: Double,
        path: String,
        issues: MutableList<ValidationIssue>,
    ) {
        when {
            !value.isFinite() -> issues += ValidationIssue(path, "must be finite")
            value < 0.0 -> issues += ValidationIssue(path, "must be non-negative")
        }
    }
}
