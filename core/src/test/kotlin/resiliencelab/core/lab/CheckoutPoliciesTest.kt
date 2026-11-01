package resiliencelab.core.lab

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.results.RunSummary
import resiliencelab.core.results.SeriesPart
import resiliencelab.core.results.WindowMetrics
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import java.util.zip.GZIPInputStream
import kotlin.test.Test

class CheckoutPoliciesTest {
    @TempDir
    lateinit var root: Path

    @Test
    fun `slow replica example separates outlier p99 intervals and aggressive checks cause a cascade`() {
        val summary = run("checkout-policies", "slow-replica")
        val plain = summary.metrics("least-in-flight")
        val protected = summary.metrics("outlier-detection")
        assertThat(
            protected.services
                .getValue("order-service#2")
                .totals.ejectedMs,
        ).isPositive()
        assertThat(
            protected.entries.total.p99LatencyMs!!
                .ci95High!!,
        ).isLessThan(
            plain.entries.total.p99LatencyMs!!
                .ci95Low!!,
        )
        val healthySummary = run("checkout-policies", "slow-replica", control = true)
        val healthy = healthySummary.metrics("least-in-flight")
        val healthyWithPolicy = healthySummary.metrics("outlier-detection")
        for (replica in 1..3) {
            assertThat(
                healthyWithPolicy.services
                    .getValue("order-service#$replica")
                    .totals.ejectedMs,
            ).isZero()
        }
        assertThat(healthyWithPolicy.entries).isEqualTo(healthy.entries)
        assertThat(protected.entries.total.p99LatencyMs.mean).isLessThan(
            healthy.entries.total.p99LatencyMs!!
                .mean * 2,
        )

        val moderate = summary.metrics("health-moderate")
        val aggressive = summary.metrics("health-aggressive")
        for (replica in 1..3) {
            assertThat(
                aggressive.services
                    .getValue("order-service#$replica")
                    .totals.notReadyMs,
            ).describedAs("aggressive check, replica %s", replica)
                .isPositive()
        }
        assertThat(
            aggressive.entries.total.failuresByReason
                .getValue("noReadyTarget")
                .mean,
        ).isPositive()
        assertThat(moderate.entries.total.failuresByReason).doesNotContainKey("noReadyTarget")
        for (replica in listOf(1, 3)) {
            assertThat(
                moderate.services
                    .getValue("order-service#$replica")
                    .totals.notReadyMs,
            ).isZero()
        }
        val windows = nodeWindows("health-aggressive")
        val firstNotReady =
            (1..3).associateWith { replica ->
                windows.getValue("order-service#$replica").filter { it.notReadyMs > 0.0 }.minOf { it.startMs }
            }
        assertThat(firstNotReady.getValue(2)).isBetween(20_000.0, 40_000.0)
        for (replica in listOf(1, 3)) {
            assertThat(firstNotReady.getValue(replica)).isGreaterThan(firstNotReady.getValue(2)).isLessThan(40_000.0)
        }
        assertThat(windows.getValue("mobile-app")).anyMatch {
            it.startMs >= 25_000.0 && it.startMs < 40_000.0 && it.failuresByReason.getOrDefault("noReadyTarget", 0) > 0
        }
    }

    @Test
    fun `PSP outage breaker protects status and fallback records successful deferred checkouts`() {
        val summary = run("checkout-policies", "psp-outage")
        val plain = summary.metrics("baseline")
        val breaker = summary.metrics("circuit-breaker")
        val fallback = summary.metrics("fallback")
        val payment = breaker.connections.getValue("order-service-to-payment-service").totals
        assertThat(payment.circuitRejections).isPositive()
        assertThat(payment.circuitOpenMs).isPositive()
        assertThat(
            breaker.entries.classes
                .getValue("status")
                .successRate!!
                .ci95Low!!,
        ).isGreaterThan(
            plain.entries.classes
                .getValue("status")
                .successRate!!
                .ci95High!!,
        )
        assertThat(
            breaker.services
                .getValue("order-service")
                .totals.slotPools
                .getValue("handlers")
                .busyIntegralMs,
        ).isLessThan(
            plain.services
                .getValue("order-service")
                .totals.slotPools
                .getValue("handlers")
                .busyIntegralMs,
        )
        assertThat(
            fallback.entries.classes
                .getValue("checkout")
                .successRate!!
                .ci95Low!!,
        ).isGreaterThan(
            breaker.entries.classes
                .getValue("checkout")
                .successRate!!
                .ci95High!!,
        )
        assertThat(
            fallback.entries.total.degradedRate!!
                .mean,
        ).isPositive()
        assertThat(
            fallback.entries.classes
                .getValue("status")
                .degradedRate!!
                .mean,
        ).isZero()
        assertThat(
            fallback.connections
                .getValue("order-service-to-payment-service")
                .totals.fallbacks,
        ).isPositive()
        assertThat(
            summary
                .metrics("retry-budget")
                .connections
                .getValue("order-service-to-payment-service")
                .totals.retriesDenied,
        ).isPositive()
    }

    @Test
    fun `partner burst raises the other client p99 while rate limiting bounds successful latency`() {
        val summary = run("checkout-policies", "partner-burst")
        val steady = summary.metrics("steady")
        val burst = summary.metrics("baseline")
        val limited = summary.metrics("rate-limit")
        assertThat(
            burst.entries.clients
                .getValue("mobile-app")
                .p99LatencyMs!!
                .ci95Low!!,
        ).isGreaterThan(
            steady.entries.clients
                .getValue("mobile-app")
                .p99LatencyMs!!
                .ci95High!!,
        )
        assertThat(
            limited.services
                .getValue("api-gateway")
                .totals.rateLimited,
        ).isPositive()
        assertThat(
            limited.entries.total.failuresByReason
                .getValue("rateLimited")
                .mean,
        ).isPositive()
        assertThat(
            limited.entries.total.pooledLatency.successful!!
                .p99Ms,
        ).isLessThan(
            steady.entries.total.pooledLatency.successful!!
                .p99Ms * 2,
        )
        assertThat(limited.entries.total.pooledLatency.successful.p99Ms)
            .isLessThan(
                burst.entries.total.pooledLatency.successful!!
                    .p99Ms,
            )
    }

    @Test
    fun `retry storm budget bounds each level amplification to twenty percent retries`() {
        val summary = run("retry-storm", "retry-budget")
        val plain = summary.metrics("baseline")
        val budget = summary.metrics("retry-budget")
        for (id in listOf("gateway-to-middle", "middle-to-dependency")) {
            val without = plain.connections.getValue(id).totals
            val with = budget.connections.getValue(id).totals
            val first = with.sentAttempts - with.retries
            assertThat(with.retriesDenied).describedAs(id).isPositive()
            assertThat(with.retries.toDouble() / first).describedAs(id).isLessThanOrEqualTo(0.2)
            assertThat(with.retries.toDouble() / first).describedAs(id).isGreaterThan(0.1)
            assertThat(without.sentAttempts.toDouble() / (without.sentAttempts - without.retries)).describedAs(id).isGreaterThan(2.8)
        }
    }

    @Test
    fun `every example artifact repeats byte for byte at one two four and eight workers`() {
        val examples =
            listOf(
                "checkout-policies" to "slow-replica",
                "checkout-policies" to "psp-outage",
                "checkout-policies" to "partner-burst",
                "retry-storm" to "retry-budget",
            )
        for ((example, experiment) in examples) {
            fun hashes(workers: Int): Map<String, String> {
                run(example, experiment, workers)
                val results = root.resolve("$example-$experiment-$workers-false/.results")
                return Files.walk(results).use { files ->
                    files.filter(Files::isRegularFile).toList().associate { file ->
                        results.relativize(file).toString() to
                            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file)))
                    }
                }
            }
            val expected = hashes(1)
            assertThat(expected.keys).anyMatch { it.endsWith(".json.gz") }
            assertThat(expected.keys).anyMatch { it.endsWith("manifest.json") }
            for (workers in listOf(2, 4, 8)) {
                val actual = hashes(workers)
                assertThat(actual.keys).containsExactlyInAnyOrderElementsOf(expected.keys)
                expected.forEach { (file, hash) ->
                    assertThat(actual.getValue(file)).describedAs("%s, %s workers, %s", experiment, workers, file).isEqualTo(hash)
                }
            }
            println("$experiment: ${expected.size} artifact files identical with 1, 2, 4 and 8 workers")
        }
    }

    private fun run(
        example: String,
        experiment: String,
        workers: Int = 4,
        control: Boolean = false,
    ): RunSummary {
        val directory = Files.createDirectories(root.resolve("$example-$experiment-$workers-$control"))
        Files.list(Path.of("../examples", example)).use { paths ->
            paths.filter { it.toString().endsWith(".json") }.forEach { Files.copy(it, directory.resolve(it.fileName)) }
        }
        if (control) {
            val path = directory.resolve("$experiment.experiment.json")
            val document = (DocumentCodec.decodeExperiment(Files.readString(path), path.toString()) as DecodeResult.Ok).value
            Files.writeString(
                path,
                DocumentCodec.encodeExperiment(
                    document.copy(
                        faults = emptyList(),
                        variants =
                            document.variants.filter {
                                it.id in
                                    setOf("least-in-flight", "outlier-detection")
                            },
                    ),
                ),
            )
        }
        return ExperimentExecutor(workers).use { executor ->
            Lab(FileWorkspace(directory), executor = executor).use { it.run("$experiment.experiment.json", "run").summary }
        }
    }

    private fun RunSummary.metrics(id: String): AggregateMetrics =
        variants
            .single { it.id == id }
            .points
            .single()
            .aggregate

    private fun nodeWindows(variant: String): Map<String, List<WindowMetrics>> =
        Files.walk(root).use { paths ->
            paths
                .filter {
                    it.parent.endsWith(Path.of(variant, "p0", "rep-0")) &&
                        it.fileName.toString().matches(Regex("part-\\d+\\.json\\.gz"))
                }.toList()
                .flatMap { file ->
                    GZIPInputStream(Files.newInputStream(file)).bufferedReader().use { reader ->
                        Json.decodeFromString(SeriesPart.serializer(), reader.readText()).nodes
                    }
                }.groupBy { it.id }
                .mapValues { (_, rows) -> rows.flatMap { it.windows } }
        }
}
