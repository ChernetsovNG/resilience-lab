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
import java.util.concurrent.TimeUnit.SECONDS

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
        assertThat(JsonPath.read<List<String>>(valid.contentAsString, "$.diagnostics[*].code"))
            .containsExactlyInAnyOrder("LINT_TIMEOUT_BUDGET", "LINT_DEADLINE_BUDGET")
        assertThat(JsonPath.read<List<String>>(valid.contentAsString, "$.diagnostics[*].severity")).containsOnly("WARNING")
        openApi.assertResponse("post", "/api/v1/validate", valid)

        val missing = postJson("/api/v1/validate", """{"experiment":"missing.experiment.json"}""")
        assertThat(JsonPath.read<Boolean>(missing.contentAsString, "$.valid")).isFalse()
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.diagnostics[0].code")).isEqualTo("DOCUMENT_MISSING")
        openApi.assertResponse("post", "/api/v1/validate", missing)
    }

    @Test
    fun `runs a job to completion`() {
        val submitted = postJson("/api/v1/jobs", """{"experiment":"$experiment"}""")
        assertThat(submitted.status).isEqualTo(202)
        openApi.assertResponse("post", "/api/v1/jobs", submitted)

        val finished = awaitJob(JsonPath.read<String>(submitted.contentAsString, "$.id"))

        assertThat(JsonPath.read<String>(finished.contentAsString, "$.status")).isEqualTo("COMPLETED")
        assertThat(JsonPath.read<Int>(finished.contentAsString, "$.completedTasks")).isEqualTo(4)
        assertThat(JsonPath.read<Int>(finished.contentAsString, "$.totalTasks")).isEqualTo(4)
        openApi.assertResponse("get", "/api/v1/jobs/{id}", finished)

        val jobs = mockMvc.perform(get("/api/v1/jobs")).andReturn().response
        assertThat(JsonPath.read<List<String>>(jobs.contentAsString, "$[*].id"))
            .contains(JsonPath.read<String>(finished.contentAsString, "$.id"))
        openApi.assertResponse("get", "/api/v1/jobs", jobs)
    }

    @Test
    fun `rejects invalid jobs, malformed requests and unknown ids`() {
        val invalid = postJson("/api/v1/jobs", """{"experiment":"missing.experiment.json"}""")
        assertThat(invalid.status).isEqualTo(400)
        assertThat(JsonPath.read<String>(invalid.contentAsString, "$.code")).isEqualTo("EXPERIMENT_INVALID")
        assertThat(JsonPath.read<String>(invalid.contentAsString, "$.diagnostics[0].code")).isEqualTo("DOCUMENT_MISSING")
        openApi.assertResponse("post", "/api/v1/jobs", invalid)

        val malformed = postJson("/api/v1/jobs", "{}")
        assertThat(malformed.status).isEqualTo(400)
        assertThat(JsonPath.read<String>(malformed.contentAsString, "$.code")).isEqualTo("REQUEST_INVALID")

        val unknown = mockMvc.perform(get("/api/v1/jobs/{id}", "unknown")).andReturn().response
        assertThat(unknown.status).isEqualTo(404)
        assertThat(JsonPath.read<String>(unknown.contentAsString, "$.code")).isEqualTo("JOB_NOT_FOUND")
        openApi.assertResponse("get", "/api/v1/jobs/{id}", unknown)
    }

    private fun awaitJob(id: String): MockHttpServletResponse {
        val deadline = System.nanoTime() + SECONDS.toNanos(60)
        while (true) {
            val response = mockMvc.perform(get("/api/v1/jobs/{id}", id)).andReturn().response
            val status = JsonPath.read<String>(response.contentAsString, "$.status")
            if (status == "COMPLETED" || status == "FAILED") return response
            check(System.nanoTime() < deadline) { "Job $id did not finish: ${response.contentAsString}" }
            Thread.sleep(50)
        }
    }

    @Test
    fun `serves finished runs`() {
        val submitted = postJson("/api/v1/jobs", """{"experiment":"$experiment"}""")
        val finished = awaitJob(JsonPath.read<String>(submitted.contentAsString, "$.id"))
        val runId = JsonPath.read<String>(finished.contentAsString, "$.runId")

        val runs = mockMvc.perform(get("/api/v1/runs")).andReturn().response
        assertThat(JsonPath.read<List<String>>(runs.contentAsString, "$[*].id")).contains(runId)
        openApi.assertResponse("get", "/api/v1/runs", runs)

        val summary = mockMvc.perform(get("/api/v1/runs/{id}/summary", runId)).andReturn().response
        assertThat(summary.status).isEqualTo(200)
        assertThat(JsonPath.read<List<String>>(summary.contentAsString, "$.variants[*].id")).containsExactly("baseline", "no-retries")
        openApi.assertResponse("get", "/api/v1/runs/{id}/summary", summary)

        val manifest = mockMvc.perform(get("/api/v1/runs/{id}/manifest", runId)).andReturn().response
        assertThat(JsonPath.read<String>(manifest.contentAsString, "$.experiment")).isEqualTo(experiment)
        assertThat(JsonPath.read<Map<String, String>>(manifest.contentAsString, "$.documents"))
            .containsOnlyKeys(experiment, "retry-storm/retry-storm.model.json")
        openApi.assertResponse("get", "/api/v1/runs/{id}/manifest", manifest)

        val missing = mockMvc.perform(get("/api/v1/runs/{id}/summary", "missing")).andReturn().response
        assertThat(missing.status).isEqualTo(404)
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.code")).isEqualTo("RUN_NOT_FOUND")
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
