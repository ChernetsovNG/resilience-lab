package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec

class OutlierDetectionCompilerTest {
    @Test
    fun `router and group call accept optional outlier detection`() {
        assertThat(compile("{}").diagnostics).isEmpty()
        assertThat(compile("{}", explicitRouter = true).diagnostics).isEmpty()
        assertThat(compile(null).diagnostics).isEmpty()
        assertThat(
            Stage1Catalog.catalog
                .type("service")!!
                .outputs
                .map { it.id },
        ).contains("ejectionsCount", "ejectedShare")
    }

    @Test
    fun `policy ranges preserve nested model and experiment pointers`() {
        for ((policy, field) in listOf(
            """{"consecutiveFailures":0}""" to "consecutiveFailures",
            """{"baseEjection":"0ms"}""" to "baseEjection",
            """{"maxEjected":"101%"}""" to "maxEjected",
        )) {
            val result = compile(policy)
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains("/connections/1/params/outlierDetection/$field")
        }
        val result = compile("{}", overrides = mapOf("call.outlierDetection.baseEjection" to JsonPrimitive("0ms")))
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.pointer }).contains("/variants/0/overrides/call.outlierDetection.baseEjection")
    }

    @Test
    fun `call outlier detection requires a replica group`() {
        for (router in listOf(false, true)) {
            val result = compile("{}", replicas = 1, explicitRouter = router, policyOnCall = true)
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("OUTLIER_TARGET")
            assertThat(result.diagnostics.map { it.pointer }).contains("/connections/1/params/outlierDetection")
        }
    }

    @Test
    fun `all callers of a group must agree including disabled policies`() {
        assertThat(compile("{}", secondPolicy = """{"consecutiveFailures":5,"baseEjection":"30000ms","maxEjected":"50%"}""").diagnostics)
            .isEmpty()
        for (other in listOf("""{"consecutiveFailures":2}""", "null")) {
            val result = compile("{}", secondPolicy = other)
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("OUTLIER_CONFIG")
        }
    }

    internal fun compile(
        policy: String?,
        replicas: Int = 3,
        explicitRouter: Boolean = false,
        policyOnCall: Boolean = !explicitRouter,
        secondPolicy: String? = null,
        overrides: Map<String, JsonElement> = emptyMap(),
    ): CompileResult {
        val callPolicy = if (policy != null && policyOnCall) ",\"outlierDetection\":$policy" else ""
        val routerPolicy = if (policy != null && !policyOnCall) ",\"outlierDetection\":$policy" else ""
        val model =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":6,"blocks":{
              "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"1/s"}]},"deadline":"1s"}},
              "entry":{"type":"service","params":{"handlers":10,"processing":{"kind":"fixed","mean":"0ms"}}},
              "backend":{"type":"service","params":{"handlers":4,"replicas":$replicas,"processing":{"kind":"fixed","mean":"1ms"}}}
              ${if (explicitRouter) ",\"router\":{\"type\":\"router\",\"params\":{\"policy\":\"roundRobin\"$routerPolicy}}" else ""}
              ${if (secondPolicy != null) ",\"other\":{\"type\":\"service\",\"params\":{\"handlers\":10,\"processing\":{\"kind\":\"fixed\",\"mean\":\"0ms\"}}},\"partner\":{\"type\":\"client\",\"params\":{\"load\":{\"points\":[{\"time\":\"0s\",\"rate\":\"1/s\"}]},\"deadline\":\"1s\"}}" else ""}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"entry"},
              {"id":"call","type":"call","from":"entry","to":"${if (explicitRouter) "router" else "backend"}","params":{"timeout":"10ms"$callPolicy}}
              ${if (explicitRouter) ",{\"id\":\"route\",\"type\":\"route\",\"from\":\"router\",\"to\":\"backend\"}" else ""}
              ${if (secondPolicy != null) ",{\"id\":\"other-request\",\"type\":\"request\",\"from\":\"partner\",\"to\":\"other\"}" else ""}
              ${if (secondPolicy != null) ",{\"id\":\"other-call\",\"type\":\"call\",\"from\":\"other\",\"to\":\"backend\",\"params\":{\"timeout\":\"10ms\",\"outlierDetection\":$secondPolicy}}" else ""}
            ]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val experiment =
            (
                DocumentCodec.decodeExperiment(
                    """{"schemaVersion":3,"modelRef":"m.model.json","execution":{"replications":1,"warmup":"0ms","measurement":"100ms","seed":1},"variants":[{"id":"baseline"}]}""",
                    "e.experiment.json",
                ) as DecodeResult.Ok
            ).value
        return ModelCompiler().compile(
            model,
            "m.model.json",
            experiment.copy(
                variants =
                    experiment.variants.map {
                        it.copy(overrides = overrides)
                    },
            ),
            "e.experiment.json",
        )
    }
}
