package resiliencelab.research.latency

import java.io.File
import ksl.utilities.statistic.Statistic
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.experiment.MetricSummary
import resiliencelab.core.lab.Lab

private fun <T> retryDecoded(result: DecodeResult<T>): T = when (result) {
    is DecodeResult.Ok -> result.value
    is DecodeResult.Failed -> error(result.diagnostics.joinToString("\n"))
}

private fun summaryFields(value: MetricSummary?): Map<String, Double?>? = value?.let {
    linkedMapOf("mean" to it.mean, "stdDev" to it.stdDev, "ci95Low" to it.ci95Low,
        "ci95High" to it.ci95High, "min" to it.min, "max" to it.max)
}

private fun approximateSummary(values: List<Double>): Map<String, Double?>? {
    if (values.isEmpty()) return null
    val stat = Statistic(values.toDoubleArray())
    val interval = if (values.size > 1) stat.confidenceInterval(0.95) else null
    return linkedMapOf("mean" to stat.average,
        "stdDev" to if (values.size > 1) stat.standardDeviation else null,
        "ci95Low" to interval?.lowerLimit, "ci95High" to interval?.upperLimit,
        "min" to stat.min, "max" to stat.max)
}

private class Observations {
    val all = mutableListOf<Double>()
    val successful = mutableListOf<Double>()
    val failed = mutableListOf<Double>()
}

private fun exactSummary(values: List<Double>): MetricSummary? = approximateSummary(values)?.let {
    MetricSummary(values.size, it.getValue("mean")!!, it["stdDev"], it["ci95Low"], it["ci95High"], it.getValue("min")!!, it.getValue("max")!!)
}

/** Runs the unchanged workspace example and compares both pooled and replication statistics. */
fun retryStorm(output: File, repository: File) {
    val experimentPath = "examples/retry-storm/retry-storm.experiment.json"
    val experimentFile = File(repository, experimentPath)
    val experiment = retryDecoded(DocumentCodec.decodeExperiment(experimentFile.readText(), experimentPath))
    val modelPath = requireNotNull(Lab.resolveRef(experimentPath, experiment.modelRef))
    val modelFile = File(repository, modelPath)
    val model = retryDecoded(DocumentCodec.decodeModel(modelFile.readText(), modelPath))
    val compilation = ModelCompiler().compile(model, modelPath, experiment, experimentPath)
    val compiled = requireNotNull(compilation.experiment) { compilation.diagnostics.joinToString("\n") }
    // Raw samples belong to this research oracle; the core retains only bounded latency sketches.
    val observations = compiled.variants.flatMap { variant ->
        (0 until compiled.run.replications).map { (variant.id to it) to Observations() }
    }.toMap()
    val run = ExperimentExecutor(workers = 1).use {
        it.run(compiled, onOriginalCompletion = { variant, replication, latency, succeeded ->
            observations.getValue(variant to replication).apply {
                all += latency
                if (succeeded) successful += latency else failed += latency
            }
        })
    }
    val fixtures = mutableListOf<Map<String, Any?>>()

    fun distribution(name: String, observations: List<Double>): Pair<Map<String, Any?>, Bins> {
        val values = observations.toDoubleArray()
        val sketch = collect(values) as LibrarySketch
        val bins = sketch.bins()
        check(bins.count == values.size.toLong())
        val quantiles = listOf(0.95, 0.99).map { p ->
            val exact = if (values.isEmpty()) null else Statistic.percentile(values.copyOf(), p)
            val approximate = bins.percentile(p)
            val native = if (values.isEmpty()) null else sketch.libraryPercentile(p)
            val relative = exact?.let { error(requireNotNull(approximate), it) }
            check((exact == null) == (approximate == null))
            check(relative == null || relative <= 0.010000000001) { "$name p=$p error=$relative" }
            mapOf("p" to p, "kslExactMs" to exact, "preservedRankMs" to approximate,
                "nativeRankMs" to native, "relativeError" to relative,
                "nativeRankRelativeError" to exact?.let { error(requireNotNull(native), it) })
        }
        fixtures += mapOf("name" to name, "values" to values, "sketch" to bins.array(),
            "probabilities" to probabilities, "quantileBits" to quantileBits(bins))
        return mapOf("count" to values.size, "rawSumMs" to values.sum(),
            "rawMeanMs" to if (values.isEmpty()) null else Statistic(values).average,
            "quantiles" to quantiles, "sketch" to bins.array()) to bins
    }

    val variants = run.variants.map { variant ->
        val approximateP95 = mutableListOf<Double>()
        val approximateP99 = mutableListOf<Double>()
        val exactP95 = mutableListOf<Double>()
        val exactP99 = mutableListOf<Double>()
        val replications = variant.replications.mapIndexed { index, raw ->
            val prefix = "retry/${variant.id}/rep-${index + 1}"
            val samples = observations.getValue(variant.id to index)
            val all = distribution("$prefix/all", samples.all)
            if (samples.all.isNotEmpty()) {
                exactP95 += Statistic.percentile(samples.all.toDoubleArray(), 0.95)
                exactP99 += Statistic.percentile(samples.all.toDoubleArray(), 0.99)
            }
            all.second.percentile(0.95)?.let(approximateP95::add)
            all.second.percentile(0.99)?.let(approximateP99::add)
            mapOf("replication" to index + 1, "originalArrivals" to raw.originalArrivals,
                "successes" to raw.successes, "failures" to raw.failures,
                "distributions" to mapOf("all" to all.first,
                    "successful" to distribution("$prefix/successful", samples.successful).first,
                    "failed" to distribution("$prefix/failed", samples.failed).first))
        }
        fun comparison(exact: MetricSummary?, values: List<Double>): Map<String, Any?> {
            val original = summaryFields(exact)
            val approximate = approximateSummary(values)
            check((original == null) == (approximate == null))
            val delta = original?.mapValues { (key, value) ->
                value?.let { approximate?.get(key)?.minus(it) }
            }
            return mapOf("exact" to original, "approximate" to approximate, "approximateMinusExact" to delta)
        }
        val prefix = "retry/${variant.id}/pooled"
        mapOf("id" to variant.id, "label" to variant.label, "replications" to replications,
            "pooled" to mapOf(
                "all" to distribution("$prefix/all", variant.replications.indices.flatMap { observations.getValue(variant.id to it).all }).first,
                "successful" to distribution("$prefix/successful", variant.replications.indices.flatMap { observations.getValue(variant.id to it).successful }).first,
                "failed" to distribution("$prefix/failed", variant.replications.indices.flatMap { observations.getValue(variant.id to it).failed }).first),
            "replicationMetricSummary" to mapOf(
                "p95LatencyMs" to comparison(exactSummary(exactP95), approximateP95),
                "p99LatencyMs" to comparison(exactSummary(exactP99), approximateP99)))
    }
    writeJson(File(output, "retry-storm.json"), mapOf("profile" to PROFILE,
        "experiment" to experimentPath, "experimentSha256" to sha256(experimentFile),
        "modelSha256" to sha256(modelFile), "seed" to compiled.run.seed,
        "replications" to compiled.run.replications, "unit" to "milliseconds",
        "quantileConvention" to "KSL R1.8.1 percentile; p*(n+1), interpolated order statistics",
        "means" to "Raw sums and KSL means are retained separately; no sketch-derived means",
        "variants" to variants))
    writeJson(File(output, "retry-fixtures.json"), mapOf("profile" to PROFILE, "cases" to fixtures))
}
