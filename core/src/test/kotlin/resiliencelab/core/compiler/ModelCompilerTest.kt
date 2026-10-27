package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.Origin
import kotlin.test.Test

class ModelCompilerTest {
    private val compiler = ModelCompiler()

    private val model =
        """
        {"schemaVersion": 1, "blocks": {
          "client": {"type": "client", "params": {"rate": "120/s", "deadline": "250ms"}},
          "gateway": {"type": "service", "params": {"handlers": 4, "queue": 16, "processing": {"kind": "fixed", "mean": "1ms"}}},
          "dependency": {"type": "service", "params": {"handlers": 2, "queue": 8, "processing": {"kind": "exponential", "mean": "8ms"}}}
        }, "connections": [
          {"id": "client-to-gateway", "type": "request", "from": "client", "to": "gateway"},
          {"id": "gateway-to-dependency", "type": "call", "from": "gateway", "to": "dependency",
           "params": {"timeout": "80ms", "attempts": 3, "backoff": {"kind": "exponential-full-jitter", "base": "2ms", "max": "20ms"}}}
        ]}
        """.trimIndent()

    private val experiment =
        """
        {"schemaVersion": 1, "modelRef": "m.model.json",
         "execution": {"replications": 2, "warmup": "0ms", "measurement": "1s", "seed": 20261025},
         "faults": [{"target": "dependency", "from": "200ms", "to": "700ms", "processingMultiplier": 6.0, "failureRate": "5%"}],
         "variants": [{"id": "baseline"}, {"id": "no-retries", "label": "No retries", "overrides": {"gateway-to-dependency.attempts": 1}}]}
        """.trimIndent()

    private fun model(text: String = model): ModelFile = (DocumentCodec.decodeModel(text, "m.model.json") as DecodeResult.Ok).value

    private fun experiment(text: String = experiment): ExperimentFile =
        (DocumentCodec.decodeExperiment(text, "e.experiment.json") as DecodeResult.Ok).value

    private fun compile(
        modelText: String = model,
        experimentText: String = experiment,
    ) = compiler.compile(model(modelText), "m.model.json", experiment(experimentText), "e.experiment.json")

    private fun codes(result: CompileResult) = result.diagnostics.map { it.code }

    @Test
    fun `compiles every variant into a canonical chain`() {
        val result = compile()

        assertThat(result.diagnostics).isEmpty()
        val compiled = result.experiment!!
        assertThat(compiled.run.replications).isEqualTo(2)
        assertThat(compiled.run.measurementMs).isEqualTo(1_000.0)
        assertThat(compiled.run.maxRealTimeSeconds).isEqualTo(30L)
        val baseline = compiled.variants.first { it.id == "baseline" }.chain
        assertThat(baseline.client.arrivalRatePerMs).isEqualTo(0.12)
        assertThat(baseline.client.deadlineMs).isEqualTo(250.0)
        assertThat(baseline.entry).isEqualTo("gateway")
        assertThat(baseline.services.map { it.path }).containsExactly("dependency", "gateway")
        assertThat(
            baseline.services
                .first()
                .processing.shape,
        ).isEqualTo(DistributionShape.EXPONENTIAL)
        val call = baseline.calls.single()
        assertThat(call.attempts).isEqualTo(3)
        assertThat(call.backoff.kind).isEqualTo(BackoffKind.EXPONENTIAL_FULL_JITTER)
        assertThat(call.backoff.multiplier).isEqualTo(2.0)
        assertThat(call.network.meanMs).isEqualTo(0.0)
        assertThat(baseline.faults.single().failureProbability).isEqualTo(0.05)
        val noRetries = compiled.variants.first { it.id == "no-retries" }
        assertThat(noRetries.label).isEqualTo("No retries")
        assertThat(
            noRetries.chain.calls
                .single()
                .attempts,
        ).isEqualTo(1)
    }

    @Test
    fun `records where every element is defined`() {
        val chain =
            compile()
                .experiment!!
                .variants
                .first()
                .chain

        assertThat(chain.client.origin).isEqualTo(Origin("m.model.json", "/blocks/client"))
        assertThat(chain.services.first().origin).isEqualTo(Origin("m.model.json", "/blocks/dependency"))
        assertThat(chain.calls.single().origin).isEqualTo(Origin("m.model.json", "/connections/1"))
        assertThat(chain.faults.single().origin).isEqualTo(Origin("e.experiment.json", "/faults/0"))
    }

    @Test
    fun `reports invalid override values at their place in the experiment`() {
        val overrides = "\"gateway-to-dependency.attempts\": 0, \"gateway-to-dependency.backoff.base\": \"x\""
        val broken = experiment.replace("\"gateway-to-dependency.attempts\": 1", overrides)

        val diagnostics = compile(experimentText = broken).diagnostics

        assertThat(diagnostics.map { Triple(it.code, it.document, it.pointer) }).containsExactlyInAnyOrder(
            Triple("PARAM_RANGE", "e.experiment.json", "/variants/1/overrides/gateway-to-dependency.attempts"),
            Triple("QUANTITY_INVALID", "e.experiment.json", "/variants/1/overrides/gateway-to-dependency.backoff.base"),
        )
    }

    @Test
    fun `request connections take no parameters`() {
        val broken = model.replace("\"to\": \"gateway\"}", "\"to\": \"gateway\", \"params\": {\"attempts\": 3}}")

        val diagnostic = compile(modelText = broken).diagnostics.single()

        assertThat(diagnostic.code).isEqualTo("PARAM_UNKNOWN")
        assertThat(diagnostic.pointer).isEqualTo("/connections/0/params/attempts")
    }

    @Test
    fun `rejects values whose derived quantities are not finite`() {
        val tinyRate = model.replace("\"rate\": \"120/s\"", "\"rate\": \"1e-320/ms\"")
        val rate = compile(modelText = tinyRate).diagnostics.single()
        assertThat(rate.code to rate.pointer).isEqualTo("PARAM_RANGE" to "/blocks/client/params/rate")

        val endless =
            experiment.replace("\"warmup\": \"0ms\", \"measurement\": \"1s\"", "\"warmup\": \"1e308ms\", \"measurement\": \"1e308ms\"")
        val window = compile(experimentText = endless).diagnostics.single()
        assertThat(window.code to window.pointer).isEqualTo("EXECUTION_RANGE" to "/execution/measurement")
    }

    @Test
    fun `document order does not change the compiled experiment`() {
        val reordered =
            """
            {"schemaVersion": 1, "connections": [
              {"id": "gateway-to-dependency", "type": "call", "from": "gateway", "to": "dependency",
               "params": {"backoff": {"max": "20ms", "base": "2ms", "kind": "exponential-full-jitter"}, "attempts": 3, "timeout": "80ms"}},
              {"id": "client-to-gateway", "type": "request", "from": "client", "to": "gateway"}
            ], "blocks": {
              "dependency": {"type": "service",
                "params": {"processing": {"mean": "8ms", "kind": "exponential"}, "queue": 8, "handlers": 2}},
              "gateway": {"type": "service",
                "params": {"queue": 16, "handlers": 4, "processing": {"kind": "fixed", "mean": "1ms"}}},
              "client": {"type": "client", "params": {"deadline": "250ms", "rate": "120/s"}}
            }}
            """.trimIndent()

        assertThat(compile(modelText = reordered).experiment!!.withoutOrigins()).isEqualTo(compile().experiment!!.withoutOrigins())
    }

    /** Pointers of connections depend on their array position; everything the engine reads must not. */
    private fun CompiledExperiment.withoutOrigins(): CompiledExperiment =
        copy(
            variants =
                variants.map { variant ->
                    val chain = variant.chain
                    variant.copy(
                        chain =
                            chain.copy(
                                client = chain.client.copy(origin = Origin.UNSPECIFIED),
                                services = chain.services.map { it.copy(origin = Origin.UNSPECIFIED) },
                                calls = chain.calls.map { it.copy(origin = Origin.UNSPECIFIED) },
                                faults = chain.faults.map { it.copy(origin = Origin.UNSPECIFIED) },
                            ),
                    )
                },
        )

    @Test
    fun `reports unknown types with pointers`() {
        val broken = model.replace("\"type\": \"client\"", "\"type\": \"robot\"")

        val result = compile(modelText = broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code to it.pointer }).contains("TYPE_UNKNOWN" to "/blocks/client/type")
    }

    @Test
    fun `reports missing parameters with pointers and block paths`() {
        val broken = model.replace("\"handlers\": 2, ", "")

        val diagnostic = compile(modelText = broken).diagnostics.single()

        assertThat(diagnostic.code).isEqualTo("PARAM_MISSING")
        assertThat(diagnostic.pointer).isEqualTo("/blocks/dependency/params/handlers")
        assertThat(diagnostic.path).isEqualTo("dependency")
        assertThat(diagnostic.document).isEqualTo("m.model.json")
    }

    @Test
    fun `rejects connections that join the wrong block types or unknown blocks`() {
        val broken =
            model
                .replace("\"type\": \"request\"", "\"type\": \"call\"")
                .replace("\"to\": \"dependency\"", "\"to\": \"nowhere\"")

        val result = compile(modelText = broken)

        assertThat(codes(result)).contains("CONNECTION_TYPE", "CONNECTION_ENDPOINT")
    }

    @Test
    fun `enforces exactly one client and a linear chain`() {
        val twoClients =
            model.replace(
                "\"gateway\": {",
                "\"spare\": {\"type\": \"client\", \"params\": {\"rate\": \"1/s\", \"deadline\": \"1s\"}}, \"gateway\": {",
            )
        assertThat(codes(compile(modelText = twoClients))).contains("TOPOLOGY_CLIENT")

        val orphan = """"orphan": {"type": "service", "params": {"handlers": 1, "processing": {"kind": "fixed", "mean": "1ms"}}}"""
        val unreachable = model.replace("\"dependency\": {", "$orphan, \"dependency\": {")
        val result = compile(modelText = unreachable)
        assertThat(result.diagnostics.single { it.code == "TOPOLOGY_CHAIN" }.path).isEqualTo("orphan")

        val back = """{"id": "back", "type": "call", "from": "dependency", "to": "gateway", "params": {"timeout": "10ms"}}"""
        val cycle = model.replace("]}", ", $back]}")
        assertThat(codes(compile(modelText = cycle))).contains("TOPOLOGY_CHAIN")
    }

    @Test
    fun `reports override paths that name no parameter`() {
        val broken = experiment.replace("gateway-to-dependency.attempts", "gateway-to-dependency.retries")

        val diagnostic = compile(experimentText = broken).diagnostics.single()

        assertThat(diagnostic.code).isEqualTo("OVERRIDE_PATH")
        assertThat(diagnostic.pointer).isEqualTo("/variants/1/overrides/gateway-to-dependency.retries")
        assertThat(diagnostic.document).isEqualTo("e.experiment.json")
    }

    @Test
    fun `applies nested overrides on top of defaults`() {
        val nested = experiment.replace("\"gateway-to-dependency.attempts\": 1", "\"gateway-to-dependency.network.mean\": \"3ms\"")

        val chain =
            compile(experimentText = nested)
                .experiment!!
                .variants
                .last()
                .chain

        assertThat(
            chain.calls
                .single()
                .network.meanMs,
        ).isEqualTo(3.0)
    }

    @Test
    fun `applies an object override before overrides of its fields whatever their order`() {
        val overlapping = "\"gateway.processing.mean\": \"3ms\", \"gateway.processing\": {\"kind\": \"fixed\", \"mean\": \"2ms\"}"
        val nested = experiment.replace("\"gateway-to-dependency.attempts\": 1", overlapping)

        val variant = compile(experimentText = nested).experiment!!.variants.last()

        val gateway = variant.chain.services.first { it.path == "gateway" }
        assertThat(gateway.processing.meanMs).isEqualTo(3.0)
    }

    @Test
    fun `checks faults and execution settings`() {
        val broken =
            experiment
                .replace("\"target\": \"dependency\"", "\"target\": \"client\"")
                .replace("\"seed\": 20261025", "\"seed\": -1")
                .replace("\"measurement\": \"1s\"", "\"measurement\": \"0ms\"")
                .replace("\"replications\": 2", "\"replications\": 0")
        assertThat(codes(compile(experimentText = broken))).contains("FAULT_TARGET", "SEED_RANGE", "EXECUTION_RANGE")

        val second = """{"target": "dependency", "from": "600ms", "to": "900ms", "processingMultiplier": 2.0}"""
        val overlapping = experiment.replace("\"failureRate\": \"5%\"}]", "\"failureRate\": \"5%\"}, $second]")
        assertThat(codes(compile(experimentText = overlapping))).containsExactly("FAULT_OVERLAP")

        val empty = experiment.replace(", \"processingMultiplier\": 6.0, \"failureRate\": \"5%\"", "")
        assertThat(codes(compile(experimentText = empty))).containsExactly("FAULT_EMPTY")
    }

    @Test
    fun `enforces distribution rules`() {
        val lognormalWithoutStdDev = model.replace("\"kind\": \"exponential\"", "\"kind\": \"lognormal\"")
        assertThat(compile(modelText = lognormalWithoutStdDev).diagnostics.single().code).isEqualTo("PARAM_MISSING")

        val zeroExponential = model.replace("\"mean\": \"8ms\"", "\"mean\": \"0ms\"")
        assertThat(compile(modelText = zeroExponential).diagnostics.single().code).isEqualTo("PARAM_RANGE")

        val fixedWithStdDev = model.replace("\"mean\": \"1ms\"", "\"mean\": \"1ms\", \"stdDev\": \"1ms\"")
        assertThat(compile(modelText = fixedWithStdDev).diagnostics.single().code).isEqualTo("DISTRIBUTION_RULE")
    }

    @Test
    fun `checks variant ids`() {
        val duplicate = experiment.replace("\"id\": \"no-retries\"", "\"id\": \"baseline\"")
        assertThat(codes(compile(experimentText = duplicate))).contains("VARIANT_DUPLICATE")

        val none = experiment.replace(Regex("\"variants\": \\[.*]}"), "\"variants\": []}")
        assertThat(codes(compile(experimentText = none))).contains("VARIANT_EMPTY")
    }
}
