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
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.util.concurrent.TimeUnit.SECONDS

@SpringBootTest
@AutoConfigureMockMvc
class ResumeApiTest {
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
    fun `API cancellation resumes to bytes identical to a continuous run`() {
        val path = longExperiment("resume-api")
        val runId = cancelViaApi(path)
        val runDirectory = ".results/resume-api/$runId"

        val runs = mockMvc.perform(get("/api/v1/runs")).andReturn().response
        val entry = JsonPath.read<List<Map<String, Any>>>(runs.contentAsString, "$[?(@.id=='$runId')]").single()
        assertThat(entry["complete"]).isEqualTo(false)
        openApi.assertResponse("get", "/api/v1/runs", runs)

        val incomplete = mockMvc.perform(get("/api/v1/runs/{id}/summary", runId)).andReturn().response
        assertThat(incomplete.status).isEqualTo(404)
        assertThat(JsonPath.read<String>(incomplete.contentAsString, "$.code")).isEqualTo("RUN_INCOMPLETE")
        openApi.assertResponse("get", "/api/v1/runs/{id}/summary", incomplete)

        val manifest = mockMvc.perform(get("/api/v1/runs/{id}/manifest", runId)).andReturn().response
        assertThat(manifest.status).isEqualTo(200)
        assertThat(JsonPath.read<Boolean>(manifest.contentAsString, "$.complete")).isFalse()
        openApi.assertResponse("get", "/api/v1/runs/{id}/manifest", manifest)

        val ready = FileWorkspace(root).listFiles(runDirectory).first { it.endsWith("/replication.json") }
        val segments = ready.split('/')
        val series =
            mockMvc
                .perform(
                    get(
                        "/api/v1/runs/{id}/series/{variant}/{cell}/{rep}",
                        runId,
                        segments[4],
                        segments[5],
                        segments[6].removePrefix("rep-"),
                    ),
                ).andReturn()
                .response
        assertThat(series.status).isEqualTo(200)
        openApi.assertResponse("get", "/api/v1/runs/{id}/series/{variant}/{cell}/{rep}", series)

        val expectedRoot = TestWorkspace.copy()
        Files.writeString(expectedRoot.resolve(path), Files.readString(root.resolve(path)))
        Lab(FileWorkspace(expectedRoot)).use { it.run(path, "continuous") }

        val submitted = postJson("/api/v1/runs/$runId/resume", "")
        assertThat(submitted.status).isEqualTo(202)
        assertThat(JsonPath.read<String>(submitted.contentAsString, "$.runId")).isEqualTo(runId)
        openApi.assertResponse("post", "/api/v1/runs/{id}/resume", submitted)
        val completed = awaitJob(JsonPath.read(submitted.contentAsString, "$.id"))
        assertThat(JsonPath.read<String>(completed.contentAsString, "$.status")).isEqualTo("COMPLETED")

        assertArtifactsEqual(expectedRoot, ".results/resume-api/continuous", root, runDirectory)

        val repeated = postJson("/api/v1/runs/$runId/resume", "")
        assertThat(repeated.status).isEqualTo(409)
        assertThat(JsonPath.read<String>(repeated.contentAsString, "$.code")).isEqualTo("RUN_COMPLETE")
        openApi.assertResponse("post", "/api/v1/runs/{id}/resume", repeated)
    }

    @Test
    fun `resume rejects unknown runs and changed documents`() {
        val unknown = postJson("/api/v1/runs/missing/resume", "")
        assertThat(unknown.status).isEqualTo(404)
        assertThat(JsonPath.read<String>(unknown.contentAsString, "$.code")).isEqualTo("RUN_NOT_FOUND")
        openApi.assertResponse("post", "/api/v1/runs/{id}/resume", unknown)

        val path = longExperiment("changed-resume")
        val runId = cancelViaApi(path)
        val model = root.resolve("retry-storm/retry-storm.model.json")
        Files.writeString(model, Files.readString(model).replace("\"handlers\": 4", "\"handlers\": 5"))

        val changed = postJson("/api/v1/runs/$runId/resume", "")
        assertThat(changed.status).isEqualTo(400)
        assertThat(JsonPath.read<String>(changed.contentAsString, "$.code")).isEqualTo("EXPERIMENT_INVALID")
        assertThat(JsonPath.read<String>(changed.contentAsString, "$.diagnostics[0].code"))
            .isEqualTo("RUN_DOCUMENT_CHANGED")
        openApi.assertResponse("post", "/api/v1/runs/{id}/resume", changed)
    }

    private fun longExperiment(name: String): String {
        val path = "retry-storm/$name.experiment.json"
        Files.writeString(
            root.resolve(path),
            Files.readString(root.resolve(experiment)).replace("\"replications\": 2", "\"replications\": 200"),
        )
        return path
    }

    private fun cancelViaApi(path: String): String {
        val submitted = postJson("/api/v1/jobs", """{"experiment":"$path"}""")
        assertThat(submitted.status).isEqualTo(202)
        val id = JsonPath.read<String>(submitted.contentAsString, "$.id")
        val deadline = System.nanoTime() + SECONDS.toNanos(30)
        while (JsonPath.read<Int>(getJob(id).contentAsString, "$.completedTasks") == 0) {
            check(System.nanoTime() < deadline) { "Job $id did not start computing" }
            Thread.sleep(10)
        }
        val requested = postJson("/api/v1/jobs/$id/cancel", "")
        assertThat(requested.status).isEqualTo(202)
        val cancelled = awaitJob(id)
        assertThat(JsonPath.read<String>(cancelled.contentAsString, "$.status")).isEqualTo("CANCELLED")
        return JsonPath.read(cancelled.contentAsString, "$.runId")
    }

    private fun getJob(id: String): MockHttpServletResponse = mockMvc.perform(get("/api/v1/jobs/{id}", id)).andReturn().response

    private fun awaitJob(id: String): MockHttpServletResponse {
        val deadline = System.nanoTime() + SECONDS.toNanos(60)
        while (true) {
            val response = getJob(id)
            val status = JsonPath.read<String>(response.contentAsString, "$.status")
            if (status == "COMPLETED" || status == "FAILED" || status == "CANCELLED") return response
            check(System.nanoTime() < deadline) { "Job $id did not finish: ${response.contentAsString}" }
            Thread.sleep(25)
        }
    }

    private fun postJson(
        path: String,
        body: String,
    ): MockHttpServletResponse = mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(body)).andReturn().response

    private fun assertArtifactsEqual(
        expectedRoot: java.nio.file.Path,
        expectedDirectory: String,
        actualRoot: java.nio.file.Path,
        actualDirectory: String,
    ) {
        val expectedFiles = FileWorkspace(expectedRoot).listFiles(expectedDirectory).map { it.removePrefix("$expectedDirectory/") }
        val actualFiles = FileWorkspace(actualRoot).listFiles(actualDirectory).map { it.removePrefix("$actualDirectory/") }
        assertThat(actualFiles).containsExactlyElementsOf(expectedFiles)
        expectedFiles.forEach { relative ->
            assertThat(Files.readAllBytes(actualRoot.resolve("$actualDirectory/$relative")))
                .describedAs(relative)
                .containsExactly(*Files.readAllBytes(expectedRoot.resolve("$expectedDirectory/$relative")))
        }
    }

    companion object {
        private val root = TestWorkspace.copy()

        @JvmStatic
        @DynamicPropertySource
        fun workspace(registry: DynamicPropertyRegistry) {
            registry.add("resilience-lab.workspace") { root.toString() }
        }
    }
}
