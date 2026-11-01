package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec

class ServicePoliciesCompilerTest {
    @Test
    fun `catalog exposes service policy outputs without adding them to databases`() {
        val outputs = listOf("rateLimitedPerSecond", "rateLimitedRate", "probeFailuresPerSecond", "notReadyShare")
        assertThat(
            Stage1Catalog.catalog
                .type("service")!!
                .outputs
                .map { it.id },
        ).containsAll(outputs)
        assertThat(
            Stage1Catalog.catalog
                .type("database")!!
                .outputs
                .map { it.id },
        ).doesNotContainAnyElementsOf(outputs)
        val database = Stage1Catalog.catalog.type("database")!!
        assertThat(database.params.map { it.name }).doesNotContain("rateLimit", "healthCheck")
        assertThat(database.version).isEqualTo(1)
    }

    @Test
    fun `optional service policies compile when enabled with defaults`() {
        val result = compile(""""rateLimit":{},"healthCheck":{}""")
        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isNotNull()
        val service =
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph.services
                .single()
        assertThat(service.rateLimit?.ratePerMs).isEqualTo(0.1)
        assertThat(service.rateLimit?.burst).isEqualTo(10)
        assertThat(service.healthCheck?.intervalMs).isEqualTo(10_000.0)
        assertThat(service.healthCheck?.timeoutMs).isEqualTo(1_000.0)
        assertThat(service.healthCheck?.unhealthyThreshold).isEqualTo(3)
        assertThat(service.healthCheck?.healthyThreshold).isEqualTo(1)
        assertThat(service.healthCheck?.processingMs).isEqualTo(1.0)
    }

    @Test
    fun `invalid service policies retain their nested pointers`() {
        for ((params, pointer) in listOf(
            """"rateLimit":{"rate":"-1/s"}""" to "rateLimit/rate",
            """"rateLimit":{"burst":0}""" to "rateLimit/burst",
            """"healthCheck":{"interval":"0ms"}""" to "healthCheck/interval",
            """"healthCheck":{"timeout":"0ms"}""" to "healthCheck/timeout",
            """"healthCheck":{"unhealthyThreshold":0}""" to "healthCheck/unhealthyThreshold",
            """"healthCheck":{"healthyThreshold":0}""" to "healthCheck/healthyThreshold",
            """"healthCheck":{"processing":"-1ms"}""" to "healthCheck/processing",
        )) {
            val result = compile(params)
            assertThat(result.experiment).describedAs(params).isNull()
            assertThat(result.diagnostics.map { it.pointer }).describedAs(params).contains("/blocks/backend/params/$pointer")
        }
    }

    @Test
    fun `invalid nested override points at the experiment`() {
        val result = compile(""""healthCheck":{}""", mapOf("backend.healthCheck.timeout" to JsonPrimitive("0ms")))
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.pointer }).contains("/variants/0/overrides/backend.healthCheck.timeout")
    }

    @Test
    fun `database policies return unknown parameter diagnostics without throwing`() {
        for (policy in listOf("rateLimit", "healthCheck")) {
            val result = compile(""""$policy":{}""", type = "database")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("PARAM_UNKNOWN")
            assertThat(result.diagnostics.map { it.pointer }).contains("/blocks/backend/params/$policy")
        }
    }

    @Test
    fun `nested variants grids and replica overrides preserve independent policies`() {
        val result =
            compile(
                """"rateLimit":{},"healthCheck":{}""",
                mapOf("backend.healthCheck.timeout" to JsonPrimitive("7ms")),
                replicas = 2,
                replicaOverrides = """{"2":{"rateLimit":{"burst":3},"healthCheck":{"interval":"20ms"}}}""",
                grid = """[{"path":"backend.rateLimit.rate","values":["10/s","30/s"]}]""",
            )
        assertThat(result.diagnostics).isEmpty()
        val points = requireNotNull(result.experiment).variants.single().points
        assertThat(points.map { it.graph.services.map { node -> node.rateLimit?.ratePerMs } })
            .containsExactly(listOf(0.01, 0.01), listOf(0.03, 0.03))
        assertThat(points.flatMap { it.graph.services }.map { it.healthCheck?.timeoutMs }).containsOnly(7.0)
        assertThat(
            points
                .first()
                .graph.services
                .map { it.rateLimit?.burst },
        ).containsExactly(10, 3)
        assertThat(
            points
                .first()
                .graph.services
                .map { it.healthCheck?.intervalMs },
        ).containsExactly(10_000.0, 20.0)
    }

    private fun compile(
        params: String,
        overrides: Map<String, JsonElement> = emptyMap(),
        replicas: Int = 1,
        replicaOverrides: String = "{}",
        grid: String = "[]",
        type: String = "service",
    ): CompileResult {
        val model =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":7,"blocks":{
                      "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"1/s"}]},"deadline":"1s"}},
                      "backend":{"type":"$type","params":{"${if (type == "database") "maxConnections" else "handlers"}":4,
                        ${if (type == "database") "" else "\"replicas\":$replicas,"}
                        "processing":{"kind":"fixed","mean":"5ms"},$params}${if (type == "service") ",\"replicaOverrides\":$replicaOverrides" else ""}}
                    },"connections":[{"id":"request","type":"request","from":"client","to":"backend"}]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val experiment =
            (
                DocumentCodec.decodeExperiment(
                    """{"schemaVersion":4,"modelRef":"m.model.json",
                      "execution":{"replications":1,"warmup":"0ms","measurement":"100ms","seed":1},
                      "variants":[{"id":"baseline"}],"grid":$grid}""",
                    "e.experiment.json",
                ) as DecodeResult.Ok
            ).value
        return ModelCompiler().compile(
            model,
            "m.model.json",
            experiment.copy(variants = experiment.variants.map { it.copy(overrides = overrides) }),
            "e.experiment.json",
        )
    }
}
