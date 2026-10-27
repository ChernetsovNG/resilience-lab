package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
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

@SpringBootTest
@AutoConfigureMockMvc
class ExperimentApiTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    private val experiment = "retry-storm/retry-storm.experiment.json"
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
    fun `validates experiments by workspace path`() {
        val valid = postJson("/api/v1/validate", """{"experiment":"$experiment"}""")

        assertThat(valid.status).isEqualTo(200)
        assertThat(JsonPath.read<Boolean>(valid.contentAsString, "$.valid")).isTrue()
        assertThat(JsonPath.read<List<Any>>(valid.contentAsString, "$.diagnostics")).isEmpty()
        openApi.assertResponse("post", "/api/v1/validate", valid)

        val missing = postJson("/api/v1/validate", """{"experiment":"missing.experiment.json"}""")
        assertThat(JsonPath.read<Boolean>(missing.contentAsString, "$.valid")).isFalse()
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.diagnostics[0].code")).isEqualTo("DOCUMENT_MISSING")
        openApi.assertResponse("post", "/api/v1/validate", missing)
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
