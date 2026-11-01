package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import resiliencelab.core.execution.ExperimentEstimate
import resiliencelab.core.lab.Lab
import java.nio.file.Files

@SpringBootTest
@AutoConfigureMockMvc
class EstimateApiTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var lab: Lab

    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val json = Json { encodeDefaults = true }
    private val openApi by lazy {
        OpenApiConformance(
            mockMvc
                .perform(get("/v3/api-docs"))
                .andReturn()
                .response
                .getContentAsString(Charsets.UTF_8),
        )
    }

    @Test
    fun `estimate matches the core result and OpenAPI`() {
        val response = postJson("/api/v1/estimate", """{"experiment":"$experiment"}""")

        assertThat(response.status).isEqualTo(200)
        val expected = json.encodeToString(ExperimentEstimate.serializer(), lab.estimate(experiment))
        assertThat(Json.parseToJsonElement(response.contentAsString)).isEqualTo(Json.parseToJsonElement(expected))
        assertThat(JsonPath.read<Int>(response.contentAsString, "$.tasks")).isEqualTo(20)
        assertThat(root.resolve(".results")).doesNotExist()
        openApi.assertResponse("post", "/api/v1/estimate", response)
    }

    @Test
    fun `estimate uses drafts without changing stored documents`() {
        val path = "retry-storm/retry-storm.model.json"
        val original = Files.readString(root.resolve(path))
        val draft = original.replace("120/s", "240/s")
        val baseline = lab.estimate(experiment)

        val response =
            postJson(
                "/api/v1/estimate",
                """{"experiment":"$experiment","drafts":[{"path":"$path","content":{"model":$draft}}]}""",
            )

        assertThat(response.status).isEqualTo(200)
        val changed = json.decodeFromString(ExperimentEstimate.serializer(), response.contentAsString)
        assertThat(changed.expectedEvents).isGreaterThan(baseline.expectedEvents)
        assertThat(changed.estimatedSeconds).isGreaterThan(baseline.estimatedSeconds)
        assertThat(Files.readString(root.resolve(path))).isEqualTo(original)
        assertThat(root.resolve(".results")).doesNotExist()
        openApi.assertResponse("post", "/api/v1/estimate", response)
    }

    @Test
    fun `estimate reports invalid experiments and draft requests`() {
        val missing = postJson("/api/v1/estimate", """{"experiment":"missing.experiment.json"}""")
        assertThat(missing.status).isEqualTo(400)
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.code")).isEqualTo("EXPERIMENT_INVALID")
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.diagnostics[0].code")).isEqualTo("DOCUMENT_MISSING")
        openApi.assertResponse("post", "/api/v1/estimate", missing)

        val layout = """{"layout":{"schemaVersion":2,"positions":{}}}"""
        val duplicate =
            """[{"path":"bad.layout.json","content":$layout},{"path":"bad.layout.json","content":$layout}]"""
        listOf(
            """[{"path":"bad.model.json","content":$layout}]""" to "DOCUMENT_KIND",
            duplicate to "DRAFT_PATH",
        ).forEach { (drafts, code) ->
            val response = postJson("/api/v1/estimate", """{"experiment":"$experiment","drafts":$drafts}""")
            assertThat(response.status).isEqualTo(400)
            assertThat(JsonPath.read<String>(response.contentAsString, "$.code")).isEqualTo(code)
            openApi.assertResponse("post", "/api/v1/estimate", response)
        }
    }

    private fun postJson(
        path: String,
        body: String,
    ): MockHttpServletResponse = mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(body)).andReturn().response

    companion object {
        private val root = TestWorkspace.copy()

        @JvmStatic
        @DynamicPropertySource
        fun workspace(registry: DynamicPropertyRegistry) {
            registry.add("resilience-lab.workspace") { root.toString() }
        }
    }
}
