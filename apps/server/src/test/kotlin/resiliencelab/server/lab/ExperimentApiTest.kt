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
import java.nio.file.Files
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
        assertThat(JsonPath.read<List<String>>(valid.contentAsString, "$.diagnostics[*].variant")).containsOnly("baseline")
        openApi.assertResponse("post", "/api/v1/validate", valid)

        val missing = postJson("/api/v1/validate", """{"experiment":"missing.experiment.json"}""")
        assertThat(JsonPath.read<Boolean>(missing.contentAsString, "$.valid")).isFalse()
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.diagnostics[0].code")).isEqualTo("DOCUMENT_MISSING")
        assertThat(JsonPath.read<String?>(missing.contentAsString, "$.diagnostics[0].variant")).isNull()
        openApi.assertResponse("post", "/api/v1/validate", missing)
    }

    @Test
    fun `validates an unsaved model without changing stored files`() {
        val path = "retry-storm/retry-storm.model.json"
        val original = Files.readString(root.resolve(path))
        val draft = original.replace("\"handlers\": 4", "\"handlers\": 0")
        val response =
            postJson(
                "/api/v1/validate",
                """{"experiment":"$experiment","drafts":[{"path":"$path","content":{"model":$draft}}]}""",
            )

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<Boolean>(response.contentAsString, "$.valid")).isFalse()
        assertThat(JsonPath.read<List<String>>(response.contentAsString, "$.diagnostics[*].pointer"))
            .contains("/blocks/gateway/params/handlers")
        assertThat(Files.readString(root.resolve(path))).isEqualTo(original)
        openApi.assertResponse("post", "/api/v1/validate", response)
        assertThat(JsonPath.read<Boolean>(postJson("/api/v1/validate", """{"experiment":"$experiment"}""").contentAsString, "$.valid"))
            .isTrue()
    }

    @Test
    fun `validates drafts of documents that do not exist yet`() {
        val model = Files.readString(root.resolve("retry-storm/retry-storm.model.json"))
        val draftExperiment =
            Files
                .readString(root.resolve(experiment))
                .replace("retry-storm.model.json", "new.model.json")
                .replace("retry-storm.layout.json", "new.layout.json")
        val response =
            postJson(
                "/api/v1/validate",
                """{"experiment":"new/new.experiment.json","drafts":[
                {"path":"new/new.experiment.json","content":{"experiment":$draftExperiment}},
                {"path":"new/new.model.json","content":{"model":$model}},
                {"path":"new/new.layout.json","content":{"layout":{"schemaVersion":1,"positions":{}}}}
            ]}""",
            )

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<Boolean>(response.contentAsString, "$.valid")).isTrue()
        assertThat(root.resolve("new")).doesNotExist()
        openApi.assertResponse("post", "/api/v1/validate", response)
    }

    @Test
    fun `rejects ambiguous draft content duplicate paths and paths outside workspace`() {
        val layout = """{"layout":{"schemaVersion":1,"positions":{}}}"""
        listOf(
            """[{"path":"bad.model.json","content":$layout}]""",
            """[{"path":"../bad.layout.json","content":$layout}]""",
            """[{"path":"bad.layout.json","content":$layout},{"path":"bad.layout.json","content":$layout}]""",
            """[{"path":"bad.layout.json","content":{}}]""",
        ).forEach { drafts ->
            val response = postJson("/api/v1/validate", """{"experiment":"$experiment","drafts":$drafts}""")
            assertThat(response.status).isEqualTo(400)
            openApi.assertResponse("post", "/api/v1/validate", response)
        }
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
    fun `grid jobs report every task and return point summaries matching OpenAPI`() {
        val path = "grid.experiment.json"
        Files.writeString(
            root.resolve(path),
            """
            {"schemaVersion":1,"modelRef":"retry-storm/retry-storm.model.json",
             "execution":{"replications":2,"warmup":"0ms","measurement":"100ms","seed":42},
             "variants":[{"id":"baseline"},{"id":"candidate"}],
             "grid":[{"path":"gateway-to-middle.timeout","values":["40ms","80ms"]},
                     {"path":"gateway-to-middle.attempts","values":[1,2,3]}]}
            """.trimIndent(),
        )
        val submitted = postJson("/api/v1/jobs", """{"experiment":"$path"}""")
        assertThat(submitted.status).isEqualTo(202)
        val finished = awaitJob(JsonPath.read<String>(submitted.contentAsString, "$.id"))
        assertThat(JsonPath.read<String>(finished.contentAsString, "$.status")).isEqualTo("COMPLETED")
        assertThat(JsonPath.read<Int>(finished.contentAsString, "$.completedTasks")).isEqualTo(24)
        assertThat(JsonPath.read<Int>(finished.contentAsString, "$.totalTasks")).isEqualTo(24)
        val runId = JsonPath.read<String>(finished.contentAsString, "$.runId")
        val summary = mockMvc.perform(get("/api/v1/runs/{id}/summary", runId)).andReturn().response
        assertThat(JsonPath.read<List<String>>(summary.contentAsString, "$.grid[*].path"))
            .containsExactly("gateway-to-middle.timeout", "gateway-to-middle.attempts")
        assertThat(JsonPath.read<List<Int>>(summary.contentAsString, "$.grid[1].values"))
            .containsExactly(1, 2, 3)
        assertThat(JsonPath.read<List<String>>(summary.contentAsString, "$.variants[0].points[*].id"))
            .containsExactly("p0", "p1", "p2", "p3", "p4", "p5")
        assertThat(JsonPath.read<String>(summary.contentAsString, "$.variants[0].points[5].coordinates['gateway-to-middle.timeout']"))
            .isEqualTo("80ms")
        assertThat(JsonPath.read<Int>(summary.contentAsString, "$.variants[0].points[5].coordinates['gateway-to-middle.attempts']"))
            .isEqualTo(3)
        openApi.assertResponse("get", "/api/v1/runs/{id}/summary", summary)
        val manifest = mockMvc.perform(get("/api/v1/runs/{id}/manifest", runId)).andReturn().response
        assertThat(JsonPath.read<List<String>>(manifest.contentAsString, "$.grid[*].path"))
            .containsExactly("gateway-to-middle.timeout", "gateway-to-middle.attempts")
        assertThat(JsonPath.read<List<String>>(manifest.contentAsString, "$.grid[0].values"))
            .containsExactly("40ms", "80ms")
        openApi.assertResponse("get", "/api/v1/runs/{id}/manifest", manifest)
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

    @Test
    fun `old result versions return a clear diagnostic instead of a decode failure`() {
        val directory = root.resolve(".results/old/unsupported")
        Files.createDirectories(directory)
        Files.writeString(directory.resolve("manifest.json"), "{\"schemaVersion\":1}")
        listOf("manifest", "summary").forEach { part ->
            val response = mockMvc.perform(get("/api/v1/runs/{id}/$part", "unsupported")).andReturn().response
            assertThat(response.status).isEqualTo(400)
            assertThat(JsonPath.read<String>(response.contentAsString, "$.code")).isEqualTo("RUN_VERSION_UNSUPPORTED")
            openApi.assertResponse("get", "/api/v1/runs/{id}/$part", response)
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
