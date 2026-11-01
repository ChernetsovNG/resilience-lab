package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.catalog.TypeCategory
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.GridAxis
import resiliencelab.core.document.ModelFile
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultKind
import resiliencelab.core.ir.Origin
import kotlin.test.Test

class ModelCompilerTest {
    private val compiler = ModelCompiler()

    private val model =
        """
        {"schemaVersion": 6, "blocks": {
          "client": {"type": "client", "params": {"load": {"points": [{"time": "0s", "rate": "120/s"}]}, "deadline": "250ms"}},
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
        {"schemaVersion": 3, "modelRef": "m.model.json",
         "execution": {"replications": 2, "warmup": "0ms", "measurement": "1s", "seed": 20261025},
         "faults": [{"target": "dependency", "from": "200ms", "to": "700ms", "kind": "slowdown", "multiplier": 6.0},
                    {"target": "dependency", "from": "200ms", "to": "700ms", "kind": "errors", "failureRate": "5%"}],
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
    fun `compiles every variant into a topologically ordered graph`() {
        val result = compile()

        assertThat(result.diagnostics).isEmpty()
        val compiled = result.experiment!!
        assertThat(compiled.run.replications).isEqualTo(2)
        assertThat(compiled.run.measurementMs).isEqualTo(1_000.0)
        assertThat(compiled.run.maxRealTimeSeconds).isEqualTo(30L)
        val baseline =
            compiled.variants
                .first { it.id == "baseline" }
                .points
                .single()
                .graph
        assertThat(
            baseline.client.load.points
                .first()
                .ratePerMs,
        ).isEqualTo(0.12)
        assertThat(baseline.client.deadlineMs).isEqualTo(250.0)
        assertThat(baseline.entry).isEqualTo("gateway")
        assertThat(baseline.services.map { it.path }).containsExactly("gateway", "dependency")
        assertThat(
            baseline.services
                .last()
                .processing.shape,
        ).isEqualTo(DistributionShape.EXPONENTIAL)
        val call = baseline.calls.single()
        assertThat(call.attempts).isEqualTo(3)
        assertThat(call.backoff.kind).isEqualTo(BackoffKind.EXPONENTIAL_FULL_JITTER)
        assertThat(call.backoff.multiplier).isEqualTo(2.0)
        assertThat(call.network.meanMs).isEqualTo(0.0)
        assertThat(baseline.faults.single { it.kind == FaultKind.ERRORS }.failureProbability).isEqualTo(0.05)
        val noRetries = compiled.variants.first { it.id == "no-retries" }
        assertThat(noRetries.label).isEqualTo("No retries")
        assertThat(
            noRetries.points
                .single()
                .graph.calls
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
                .points
                .single()
                .graph

        assertThat(chain.client.origin).isEqualTo(Origin("m.model.json", "/blocks/client"))
        assertThat(chain.services.last().origin).isEqualTo(Origin("m.model.json", "/blocks/dependency"))
        assertThat(chain.calls.single().origin).isEqualTo(Origin("m.model.json", "/connections/1"))
        assertThat(chain.faults.first().origin).isEqualTo(Origin("e.experiment.json", "/faults/0"))
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
        assertThat(diagnostics).allSatisfy {
            assertThat(Json.encodeToJsonElement(it).jsonObject["variant"]).isEqualTo(JsonPrimitive("no-retries"))
        }
        val range = diagnostics.single { it.code == "PARAM_RANGE" }
        assertThat(range.message).isEqualTo("Parameter 'attempts' is out of range: >= 1")
        assertThat(Json.encodeToJsonElement(range).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"reason":"minimum","parameter":"attempts","minimum":1.0}"""))
    }

    @Test
    fun `linter warnings point to the overridden value and carry the variant`() {
        listOf(
            Triple("LINT_TIMEOUT_BUDGET", "gateway-to-dependency.timeout", "\"1ms\""),
            Triple("LINT_RETRY_AMPLIFICATION", "gateway-to-dependency.attempts", "11"),
            Triple("LINT_HANDLERS_LITTLE", "gateway.handlers", "1"),
            Triple("LINT_DEADLINE_BUDGET", "client.deadline", "\"1ms\""),
        ).forEach { (code, parameter, value) ->
            val changed = experiment.replace("\"gateway-to-dependency.attempts\": 1", "\"$parameter\": $value")
            val compiled = compile(experimentText = changed)
            assertThat(compiled.diagnostics).isEmpty()

            val warning = ModelLinter().lint(compiled.experiment!!).single { it.code == code }

            assertThat(warning.document).isEqualTo("e.experiment.json")
            assertThat(warning.pointer).isEqualTo("/variants/1/overrides/$parameter")
            assertThat(warning.path).isEqualTo(parameter.substringBefore('.'))
            assertThat(Json.encodeToJsonElement(warning).jsonObject["variant"]).isEqualTo(JsonPrimitive("no-retries"))
            assertThat(warning.message).doesNotContain("variants:")
        }
    }

    @Test
    fun `a warning from the only variant override retains its variant`() {
        val source = experiment()
        val solo = source.variants.last().copy(id = "solo", overrides = mapOf("gateway.handlers" to JsonPrimitive(1)))
        val compiled = compiler.compile(model(), "m.model.json", source.copy(variants = listOf(solo)), "e.experiment.json")

        val warning = ModelLinter().lint(compiled.experiment!!).single { it.code == "LINT_HANDLERS_LITTLE" }

        assertThat(warning.code).isEqualTo("LINT_HANDLERS_LITTLE")
        assertThat(warning.variant).isEqualTo("solo")
        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/0/overrides/gateway.handlers")
    }

    @Test
    fun `jitter warnings retain backoff override origins and grid points`() {
        val base = experiment()
        val changed =
            base.copy(
                variants =
                    listOf(
                        base.variants.first().copy(
                            id = "fixed",
                            overrides = mapOf("gateway-to-dependency.backoff.kind" to JsonPrimitive("fixed")),
                        ),
                    ),
                grid = listOf(GridAxis("gateway-to-dependency.attempts", listOf(JsonPrimitive(1), JsonPrimitive(2)))),
            )
        val result = compiler.compile(model(), "m.model.json", changed, "e.experiment.json")
        assertThat(result.diagnostics).isEmpty()

        val warning = ModelLinter().lint(requireNotNull(result.experiment)).single { it.code == "LINT_RETRY_NO_JITTER" }

        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/0/overrides/gateway-to-dependency.backoff.kind")
        assertThat(warning.variant).isEqualTo("fixed")
        assertThat(warning.args).containsEntry("points", JsonPrimitive("p1"))
        assertThat(warning.message).contains("points: p1")
    }

    @Test
    fun `whole backoff overrides retain each variant origin instead of becoming a common warning`() {
        val backoff = Json.parseToJsonElement("""{"kind":"fixed","base":"2ms","max":"20ms"}""")
        val source =
            experiment().let {
                it.copy(
                    variants =
                        it.variants.map { variant ->
                            variant.copy(overrides = mapOf("gateway-to-dependency.backoff" to backoff))
                        },
                )
            }
        val result = compiler.compile(model(), "m.model.json", source, "e.experiment.json")
        assertThat(result.diagnostics).isEmpty()

        val warnings = ModelLinter().lint(requireNotNull(result.experiment)).filter { it.code == "LINT_RETRY_NO_JITTER" }

        assertThat(warnings.map { it.variant to it.pointer }).containsExactly(
            "baseline" to "/variants/0/overrides/gateway-to-dependency.backoff",
            "no-retries" to "/variants/1/overrides/gateway-to-dependency.backoff",
        )
        assertThat(warnings).allSatisfy { assertThat(it.document).isEqualTo("e.experiment.json") }
    }

    @Test
    fun `whole backoff grid values retain their origins and affected points`() {
        val jitter = Json.parseToJsonElement("""{"kind":"exponential-full-jitter","base":"2ms","max":"20ms"}""")
        val fixed = Json.parseToJsonElement("""{"kind":"fixed","base":"2ms","max":"20ms"}""")
        val source = experiment().copy(grid = listOf(GridAxis("gateway-to-dependency.backoff", listOf(jitter, fixed))))
        val result = compiler.compile(model(), "m.model.json", source, "e.experiment.json")
        assertThat(result.diagnostics).isEmpty()

        val warning = ModelLinter().lint(requireNotNull(result.experiment)).single { it.code == "LINT_RETRY_NO_JITTER" }

        assertThat(warning.variant).isEqualTo("baseline")
        assertThat(warning.pointer).isEqualTo("/grid/0/values/1")
        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.args).containsEntry("points", JsonPrimitive("p1"))
    }

    @Test
    fun `common jitter warnings are grouped across variants`() {
        val changed = model.replace("exponential-full-jitter", "fixed")
        val source = experiment().let { it.copy(variants = it.variants.map { variant -> variant.copy(overrides = emptyMap()) }) }
        val result = compiler.compile(model(changed), "m.model.json", source, "e.experiment.json")
        assertThat(result.diagnostics).isEmpty()

        val warning = ModelLinter().lint(requireNotNull(result.experiment)).single { it.code == "LINT_RETRY_NO_JITTER" }

        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/1/params/backoff/kind")
        assertThat(warning.variant).isNull()
    }

    @Test
    fun `unreachable timeout warnings retain variant override origins`() {
        val source =
            experiment().copy(
                variants =
                    experiment().variants.map { variant ->
                        if (variant.id == "no-retries") {
                            variant.copy(overrides = variant.overrides + ("gateway-to-dependency.timeout" to JsonPrimitive("250ms")))
                        } else {
                            variant
                        }
                    },
            )
        val compiled = compiler.compile(model(), "m.model.json", source, "e.experiment.json")
        assertThat(compiled.diagnostics).isEmpty()

        val warning = ModelLinter().lint(compiled.experiment!!).single { it.code == "LINT_TIMEOUT_UNREACHABLE" }

        assertThat(warning.document).isEqualTo("e.experiment.json")
        assertThat(warning.pointer).isEqualTo("/variants/1/overrides/gateway-to-dependency.timeout")
        assertThat(warning.variant).isEqualTo("no-retries")
        assertThat(warning.path).isEqualTo("gateway-to-dependency")
    }

    @Test
    fun `unreachable timeout warnings retain grid origins and affected points`() {
        val source =
            experiment().copy(
                grid =
                    listOf(
                        GridAxis(
                            "gateway-to-dependency.timeout",
                            listOf(JsonPrimitive("249.999ms"), JsonPrimitive("250ms"), JsonPrimitive("300ms")),
                        ),
                    ),
            )
        val compiled = compiler.compile(model(), "m.model.json", source, "e.experiment.json")
        assertThat(compiled.diagnostics).isEmpty()

        val warnings = ModelLinter().lint(compiled.experiment!!).filter { it.code == "LINT_TIMEOUT_UNREACHABLE" }

        assertThat(warnings.map { it.variant to it.pointer }).containsExactly(
            "baseline" to "/grid/0/values/1",
            "baseline" to "/grid/0/values/2",
            "no-retries" to "/grid/0/values/1",
            "no-retries" to "/grid/0/values/2",
        )
        assertThat(warnings.map { it.args?.get("points") }).containsExactly(
            JsonPrimitive("p1"),
            JsonPrimitive("p2"),
            JsonPrimitive("p1"),
            JsonPrimitive("p2"),
        )
        assertThat(warnings).allSatisfy { assertThat(it.document).isEqualTo("e.experiment.json") }
    }

    @Test
    fun `common unreachable timeout warnings are grouped across variants`() {
        val compiled = compiler.compile(model(model.replace("\"80ms\"", "\"250ms\"")), "m.model.json", experiment(), "e.experiment.json")
        assertThat(compiled.diagnostics).isEmpty()

        val warning = ModelLinter().lint(compiled.experiment!!).single { it.code == "LINT_TIMEOUT_UNREACHABLE" }

        assertThat(warning.document).isEqualTo("m.model.json")
        assertThat(warning.pointer).isEqualTo("/connections/1/params/timeout")
        assertThat(warning.variant).isNull()
    }

    @Test
    fun `deadline warnings retain grid value origins and variant budgets`() {
        val source =
            experiment().copy(
                grid = listOf(GridAxis("client.deadline", listOf(JsonPrimitive("80ms"), JsonPrimitive("81ms"), JsonPrimitive("247ms")))),
            )
        val compiled = compiler.compile(model(), "m.model.json", source, "e.experiment.json")
        assertThat(compiled.diagnostics).isEmpty()

        val warnings = ModelLinter().lint(compiled.experiment!!).filter { it.code == "LINT_DEADLINE_BUDGET" }

        assertThat(warnings.map { it.variant to it.pointer }).containsExactly(
            "baseline" to "/grid/0/values/0",
            "baseline" to "/grid/0/values/1",
            "no-retries" to "/grid/0/values/0",
        )
        assertThat(warnings.map { it.message.substringAfterLast("(points: ") }).containsExactly("p0)", "p1)", "p0)")
        assertThat(warnings).allSatisfy {
            assertThat(it.document).isEqualTo("e.experiment.json")
            assertThat(it.path).isEqualTo("client")
            assertThat(it.severity).isEqualTo(Severity.WARNING)
        }
        assertThat(warnings.map { it.args }).containsExactly(
            mapOf("deadlineMs" to JsonPrimitive(80.0), "requiredMs" to JsonPrimitive(247.0), "points" to JsonPrimitive("p0")),
            mapOf("deadlineMs" to JsonPrimitive(81.0), "requiredMs" to JsonPrimitive(247.0), "points" to JsonPrimitive("p1")),
            mapOf("deadlineMs" to JsonPrimitive(80.0), "requiredMs" to JsonPrimitive(81.0), "points" to JsonPrimitive("p0")),
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
        val tinyRate =
            model.replace(
                "\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"120/s\"}]}",
                "\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"1e-320/ms\"}]}",
            )
        val rate = compile(modelText = tinyRate).diagnostics.single()
        assertThat(rate.code to rate.pointer).isEqualTo("LOAD_RANGE" to "/blocks/client/params/load")

        val endless =
            experiment.replace("\"warmup\": \"0ms\", \"measurement\": \"1s\"", "\"warmup\": \"1e308ms\", \"measurement\": \"1e308ms\"")
        val window = compile(experimentText = endless).diagnostics.single()
        assertThat(window.code to window.pointer).isEqualTo("EXECUTION_RANGE" to "/execution/measurement")
    }

    @Test
    fun `document order does not change the compiled experiment`() {
        val reordered =
            """
            {"schemaVersion": 6, "connections": [
              {"id": "gateway-to-dependency", "type": "call", "from": "gateway", "to": "dependency",
               "params": {"backoff": {"max": "20ms", "base": "2ms", "kind": "exponential-full-jitter"}, "attempts": 3, "timeout": "80ms"}},
              {"id": "client-to-gateway", "type": "request", "from": "client", "to": "gateway"}
            ], "blocks": {
              "dependency": {"type": "service",
                "params": {"processing": {"mean": "8ms", "kind": "exponential"}, "queue": 8, "handlers": 2}},
              "gateway": {"type": "service",
                "params": {"queue": 16, "handlers": 4, "processing": {"kind": "fixed", "mean": "1ms"}}},
              "client": {"type": "client", "params": {"deadline": "250ms", "load": {"points": [{"time": "0s", "rate": "120/s"}]}}}
            }}
            """.trimIndent()

        assertThat(compile(modelText = reordered).experiment!!.withoutOrigins()).isEqualTo(compile().experiment!!.withoutOrigins())
    }

    /** Pointers of connections depend on their array position; everything the engine reads must not. */
    private fun CompiledExperiment.withoutOrigins(): CompiledExperiment =
        copy(
            variants =
                variants.map { variant ->
                    variant.copy(
                        points =
                            variant.points.map { point ->
                                val chain = point.graph
                                point.copy(
                                    graph =
                                        chain.copy(
                                            clients = listOf(chain.client.copy(origin = Origin.UNSPECIFIED)),
                                            services = chain.services.map { it.copy(origin = Origin.UNSPECIFIED) },
                                            calls = chain.calls.map { it.copy(origin = Origin.UNSPECIFIED) },
                                            faults = chain.faults.map { it.copy(origin = Origin.UNSPECIFIED) },
                                        ),
                                )
                            },
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
    fun `enforces one request per client and an acyclic reachable graph`() {
        val twoClients =
            model.replace(
                "\"gateway\": {",
                "\"spare\": {\"type\": \"client\", \"params\": {\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"1/s\"}]}, \"deadline\": \"1s\"}}, \"gateway\": {",
            )
        assertThat(codes(compile(modelText = twoClients))).contains("CLIENT_REQUEST")

        val orphan = """"orphan": {"type": "service", "params": {"handlers": 1, "processing": {"kind": "fixed", "mean": "1ms"}}}"""
        val unreachable = model.replace("\"dependency\": {", "$orphan, \"dependency\": {")
        val result = compile(modelText = unreachable)
        assertThat(result.diagnostics.single { it.code == "TOPOLOGY_GRAPH" }.path).isEqualTo("orphan")

        val back = """{"id": "back", "type": "call", "from": "dependency", "to": "gateway", "params": {"timeout": "10ms"}}"""
        val cycle = model.replace("]}", ", $back]}")
        assertThat(codes(compile(modelText = cycle))).contains("TOPOLOGY_GRAPH")
    }

    @Test
    fun `reports override paths that name no parameter`() {
        val broken = experiment.replace("gateway-to-dependency.attempts", "gateway-to-dependency.retries")

        val diagnostic = compile(experimentText = broken).diagnostics.single()

        assertThat(diagnostic.code).isEqualTo("OVERRIDE_PATH")
        assertThat(diagnostic.pointer).isEqualTo("/variants/1/overrides/gateway-to-dependency.retries")
        assertThat(diagnostic.document).isEqualTo("e.experiment.json")
        assertThat(diagnostic.variant).isEqualTo("no-retries")
    }

    @Test
    fun `applies nested overrides on top of defaults`() {
        val nested = experiment.replace("\"gateway-to-dependency.attempts\": 1", "\"gateway-to-dependency.network.mean\": \"3ms\"")

        val chain =
            compile(experimentText = nested)
                .experiment!!
                .variants
                .last()
                .points
                .single()
                .graph

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

        val gateway =
            variant.points
                .single()
                .graph.services
                .first { it.path == "gateway" }
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

        val second = """{"target": "dependency", "from": "600ms", "to": "900ms", "kind": "slowdown", "multiplier": 2.0}"""
        val overlapping = experiment.replace("\"failureRate\": \"5%\"}]", "\"failureRate\": \"5%\"}, $second]")
        assertThat(codes(compile(experimentText = overlapping))).isEmpty()

        val empty = experiment.replace(", \"multiplier\": 6.0", "")
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

    private fun compile(
        model: ModelFile,
        experiment: ExperimentFile = experiment(),
    ) = compiler.compile(model, "m.model.json", experiment, "e.experiment.json")

    @Test
    fun `unknown endpoints do not hide an independent cycle or parameter error`() {
        val base = model()
        val call = base.connections[1]
        val broken =
            base.copy(
                connections =
                    base.connections +
                        listOf(
                            call.copy(id = "back", from = "dependency", to = "gateway"),
                            call.copy(id = "malformed", from = "missing-from", to = "missing-to"),
                        ),
                blocks =
                    base.blocks + (
                        "gateway" to
                            base.blocks.getValue("gateway").copy(
                                params = JsonObject(base.blocks.getValue("gateway").params + ("handlers" to JsonPrimitive(0))),
                            )
                    ),
            )

        val result = compile(broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code to it.pointer }).contains(
            "CONNECTION_ENDPOINT" to "/connections/3/from",
            "CONNECTION_ENDPOINT" to "/connections/3/to",
            "PARAM_RANGE" to "/blocks/gateway/params/handlers",
        )
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.message).contains("cycle")
            assertThat(it.document).isEqualTo("m.model.json")
            assertThat(it.path).isIn("gateway-to-dependency", "back")
        }
    }

    @Test
    fun `unknown endpoints do not hide independent branching or invent unreachable services`() {
        val base = model()
        val call = base.connections[1]
        val broken =
            base.copy(
                blocks = base.blocks + ("other" to base.blocks.getValue("dependency")),
                connections =
                    base.connections +
                        listOf(
                            call.copy(id = "branch", to = "other"),
                            call.copy(id = "malformed", from = "missing-from", to = "missing-to"),
                        ),
            )

        val result = compile(broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code to it.pointer }).contains(
            "CONNECTION_ENDPOINT" to "/connections/3/from",
            "CONNECTION_ENDPOINT" to "/connections/3/to",
        )
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.message).contains("needs a scenario")
            assertThat(it.pointer).isEqualTo("/blocks/gateway")
        }
        assertThat(result.diagnostics).noneSatisfy { assertThat(it.message).contains("not reachable") }
    }

    @Test
    fun `unknown endpoints do not hide an independent disconnected service`() {
        val base = model()
        val broken =
            base.copy(
                blocks = base.blocks + ("orphan" to base.blocks.getValue("dependency")),
                connections = base.connections + base.connections[1].copy(id = "malformed", from = "missing-from", to = "missing-to"),
            )

        val result = compile(broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code to it.pointer }).contains(
            "CONNECTION_ENDPOINT" to "/connections/2/from",
            "CONNECTION_ENDPOINT" to "/connections/2/to",
        )
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.message).contains("not reachable")
            assertThat(it.pointer).isEqualTo("/blocks/orphan")
            assertThat(it.path).isEqualTo("orphan")
        }
    }

    @Test
    fun `detects cycles in disconnected components`() {
        val base = model()
        val call = base.connections[1]
        val broken =
            base.copy(
                blocks = base.blocks + mapOf("a" to base.blocks.getValue("dependency"), "b" to base.blocks.getValue("dependency")),
                connections =
                    base.connections +
                        listOf(
                            call.copy(id = "a-b", from = "a", to = "b"),
                            call.copy(id = "b-a", from = "b", to = "a"),
                        ),
            )

        val result = compile(broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.filter { "not reachable" in it.message }.map { it.path }).containsExactly("a", "b")
        assertThat(result.diagnostics).anySatisfy {
            assertThat(it.message).contains("cycle")
            assertThat(it.path).isIn("a-b", "b-a")
        }
    }

    @Test
    fun `invalid override paths do not hide independent values in any variant`() {
        val base = experiment()
        val broken =
            base.copy(
                variants =
                    base.variants.map {
                        it.copy(overrides = mapOf("missing.timeout" to JsonPrimitive("1s"), "gateway.handlers" to JsonPrimitive(0)))
                    },
            )

        val result = compile(model(), broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { Triple(it.code, it.document, it.pointer) }).containsExactlyInAnyOrder(
            Triple("OVERRIDE_PATH", "e.experiment.json", "/variants/0/overrides/missing.timeout"),
            Triple("PARAM_RANGE", "e.experiment.json", "/variants/0/overrides/gateway.handlers"),
            Triple("OVERRIDE_PATH", "e.experiment.json", "/variants/1/overrides/missing.timeout"),
            Triple("PARAM_RANGE", "e.experiment.json", "/variants/1/overrides/gateway.handlers"),
        )
    }

    @Test
    fun `invalid lognormal mean does not hide missing standard deviation`() {
        listOf("0ms" to "PARAM_RANGE", "bad" to "QUANTITY_INVALID").forEach { (mean, code) ->
            val broken = model.replace("\"kind\": \"exponential\", \"mean\": \"8ms\"", "\"kind\": \"lognormal\", \"mean\": \"$mean\"")
            val result = compile(modelText = broken)

            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code to it.pointer }).containsExactlyInAnyOrder(
                code to "/blocks/dependency/params/processing/mean",
                "PARAM_MISSING" to "/blocks/dependency/params/processing/stdDev",
            )
        }
    }

    @Test
    fun `invalid network lognormal mean preserves missing standard deviation pointer`() {
        val broken =
            model.replace(
                "\"timeout\": \"80ms\"",
                "\"network\": {\"kind\": \"lognormal\", \"mean\": \"bad\"}, \"timeout\": \"80ms\"",
            )
        val result = compile(modelText = broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { Triple(it.code, it.document, it.pointer) }).containsExactlyInAnyOrder(
            Triple("QUANTITY_INVALID", "m.model.json", "/connections/1/params/network/mean"),
            Triple("PARAM_MISSING", "m.model.json", "/connections/1/params/network/stdDev"),
        )
        assertThat(result.diagnostics.map { it.path }).containsOnly("gateway-to-dependency")
    }

    @Test
    fun `unresolved call endpoints produce no invented topology errors`() {
        val base = model()
        val broken =
            base.copy(
                connections = base.connections + base.connections[1].copy(id = "malformed", from = "missing-from", to = "missing-to"),
            )

        val result = compile(broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code to it.pointer }).containsExactlyInAnyOrder(
            "CONNECTION_ENDPOINT" to "/connections/2/from",
            "CONNECTION_ENDPOINT" to "/connections/2/to",
        )
    }

    @Test
    fun `invalid request endpoints do not crash or invent reachability diagnostics`() {
        val base = model()
        listOf("missing", "client").forEach { target ->
            val broken = base.copy(connections = listOf(base.connections[0].copy(to = target), base.connections[1]))

            val result = compile(broken)

            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).containsAnyOf("CONNECTION_ENDPOINT", "CONNECTION_TYPE")
            assertThat(result.diagnostics).noneSatisfy { assertThat(it.message).contains("not reachable") }
        }
    }

    @Test
    fun `positive real time caps round up to at least one second`() {
        mapOf("4.9e-324ms" to 1L, "1ms" to 1L, "1001ms" to 2L, "30s" to 30L).forEach { (cap, seconds) ->
            val base = experiment()
            val result = compile(model(), base.copy(execution = base.execution.copy(maxRealTime = cap)))

            assertThat(result.diagnostics).describedAs(cap).isEmpty()
            assertThat(result.experiment!!.run.maxRealTimeSeconds).describedAs(cap).isEqualTo(seconds)
        }
    }

    @Test
    fun `rejects zero negative malformed and nonfinite real time caps`() {
        listOf("0ms", "-1ms", "bad", "1e309ms").forEach { cap ->
            val base = experiment()
            val result = compile(model(), base.copy(execution = base.execution.copy(maxRealTime = cap)))

            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.document to it.pointer })
                .describedAs(cap)
                .containsExactly("e.experiment.json" to "/execution/maxRealTime")
        }
    }

    @Test
    fun `missing client catalog descriptor returns diagnostics`() = assertMissingCatalogType("client")

    @Test
    fun `missing service catalog descriptor returns diagnostics`() = assertMissingCatalogType("service")

    @Test
    fun `missing request catalog descriptor returns diagnostics`() = assertMissingCatalogType("request")

    @Test
    fun `missing call catalog descriptor returns diagnostics`() = assertMissingCatalogType("call")

    private fun assertMissingCatalogType(type: String) {
        val catalog = Stage1Catalog.catalog.copy(types = Stage1Catalog.catalog.types.filterNot { it.id == type })
        val compiler = ModelCompiler(catalog)
        val result = compiler.compile(model(), "m.model.json", experiment(), "e.experiment.json")

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code }).describedAs(type).contains("TYPE_UNKNOWN")

        val (broken, pointer) =
            if (type == "service") {
                model.replace(
                    "\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"120/s\"}]}",
                    "\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"1e-320/ms\"}]}",
                ) to
                    "/blocks/client/params/load"
            } else {
                model.replace("\"handlers\": 4", "\"handlers\": 0") to "/blocks/gateway/params/handlers"
            }
        val independent = compiler.compile(model(broken), "m.model.json", experiment(), "e.experiment.json")

        assertThat(independent.experiment).isNull()
        assertThat(independent.diagnostics.map { Triple(it.code, it.document, it.pointer) })
            .describedAs(type)
            .contains(Triple(if (type == "service") "LOAD_RANGE" else "PARAM_RANGE", "m.model.json", pointer))
    }

    @Test
    fun `an unused missing catalog descriptor does not reject a valid model`() {
        val catalog = Stage1Catalog.catalog.copy(types = Stage1Catalog.catalog.types.filterNot { it.id == "call" })
        val base = model()
        val singleService = base.copy(blocks = base.blocks - "dependency", connections = base.connections.take(1))
        val baseExperiment = experiment()
        val baseline = baseExperiment.copy(faults = emptyList(), variants = baseExperiment.variants.take(1))

        val result = ModelCompiler(catalog).compile(singleService, "m.model.json", baseline, "e.experiment.json")

        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isEqualTo(compile(singleService, baseline).experiment)
    }

    @Test
    fun `wrong category client catalog descriptor returns diagnostics`() = assertWrongCatalogCategory("client")

    @Test
    fun `wrong category service catalog descriptor returns diagnostics`() = assertWrongCatalogCategory("service")

    @Test
    fun `wrong category request catalog descriptor skips parameter diagnostics`() = assertWrongCatalogCategory("request")

    @Test
    fun `wrong category call catalog descriptor returns diagnostics`() = assertWrongCatalogCategory("call")

    private fun assertWrongCatalogCategory(type: String) {
        val catalog =
            Stage1Catalog.catalog.copy(
                types =
                    Stage1Catalog.catalog.types.map {
                        if (it.id != type) {
                            it
                        } else {
                            it.copy(
                                category = if (it.category == TypeCategory.BLOCK) TypeCategory.CONNECTION else TypeCategory.BLOCK,
                                params = emptyList(),
                            )
                        }
                    },
            )
        val compiler = ModelCompiler(catalog)
        val modelText =
            if (type == "request") {
                model.replace("\"to\": \"gateway\"}", "\"to\": \"gateway\", \"params\": {\"unexpected\": 0}}")
            } else {
                model
            }
        val result = compiler.compile(model(modelText), "m.model.json", experiment(), "e.experiment.json")

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code }).describedAs(type).contains("TYPE_UNKNOWN").doesNotContain("PARAM_UNKNOWN")

        val (broken, pointer) =
            if (type == "service") {
                modelText.replace(
                    "\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"120/s\"}]}",
                    "\"load\": {\"points\": [{\"time\": \"0s\", \"rate\": \"1e-320/ms\"}]}",
                ) to
                    "/blocks/client/params/load"
            } else {
                modelText.replace("\"handlers\": 4", "\"handlers\": 0") to "/blocks/gateway/params/handlers"
            }
        val independent = compiler.compile(model(broken), "m.model.json", experiment(), "e.experiment.json")

        assertThat(independent.experiment).isNull()
        assertThat(independent.diagnostics.map { Triple(it.code, it.document, it.pointer) })
            .describedAs(type)
            .contains(Triple(if (type == "service") "LOAD_RANGE" else "PARAM_RANGE", "m.model.json", pointer))
    }

    @Test
    fun `an unused wrong category descriptor does not reject a valid model`() {
        val catalog =
            Stage1Catalog.catalog.copy(
                types =
                    Stage1Catalog.catalog.types.map {
                        if (it.id == "call") it.copy(category = TypeCategory.BLOCK, params = emptyList()) else it
                    },
            )
        val base = model()
        val singleService = base.copy(blocks = base.blocks - "dependency", connections = base.connections.take(1))
        val baseExperiment = experiment()
        val baseline = baseExperiment.copy(faults = emptyList(), variants = baseExperiment.variants.take(1))

        val result = ModelCompiler(catalog).compile(singleService, "m.model.json", baseline, "e.experiment.json")

        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isEqualTo(compile(singleService, baseline).experiment)
    }

    @Test
    fun `checks variant ids`() {
        val duplicate = experiment.replace("\"id\": \"no-retries\"", "\"id\": \"baseline\"")
        val duplicateDiagnostic = compile(experimentText = duplicate).diagnostics.single { it.code == "VARIANT_DUPLICATE" }
        assertThat(duplicateDiagnostic.variant).isEqualTo("baseline")
        assertThat(duplicateDiagnostic.pointer).isEqualTo("/variants/1/id")

        val invalid = experiment.replace("\"id\": \"no-retries\"", "\"id\": \"invalid id\"")
        val invalidDiagnostic = compile(experimentText = invalid).diagnostics.single { it.code == "ID_INVALID" }
        assertThat(invalidDiagnostic.variant).isEqualTo("invalid id")
        assertThat(invalidDiagnostic.pointer).isEqualTo("/variants/1/id")

        val none = experiment.replace(Regex("\"variants\": \\[.*]}"), "\"variants\": []}")
        assertThat(codes(compile(experimentText = none))).contains("VARIANT_EMPTY")
    }
}
