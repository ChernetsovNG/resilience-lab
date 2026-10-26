package resiliencelab.server.api

import com.jayway.jsonpath.JsonPath
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.BDDMockito.given
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import resiliencelab.core.experiment.ExperimentResult
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.ExperimentDocument
import resiliencelab.server.experiment.ExperimentExecutor
import resiliencelab.server.experiment.ExperimentJob
import resiliencelab.server.experiment.ExperimentJobManager
import resiliencelab.server.experiment.ExperimentJobStatus
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

@WebMvcTest(ExperimentController::class)
@Import(ExperimentService::class)
class ExperimentControllerTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @MockitoBean
    private lateinit var jobManager: ExperimentJobManager

    @Test
    fun `valid submission prepares the document before queueing a job`() {
        val id = UUID.randomUUID()
        val body = """{"experiment":$validExperiment}"""
        val prepared = ExperimentSubmissionCodec.decode(body).experiment!!
        given(jobManager.submit(prepared)).willReturn(id)

        val response = submit(body)

        verify(jobManager).submit(prepared)
        assertThat(response.status).isEqualTo(202)
        assertThat(JsonPath.read<Map<String, Any>>(response.contentAsString, "$"))
            .containsExactlyInAnyOrderEntriesOf(mapOf("id" to id.toString(), "status" to "QUEUED"))
        assertThat(prepared.execution.replications).isEqualTo(1)
        assertThat(prepared.variants.single().id).isEqualTo("baseline")
    }

    @Test
    fun `invalid submission is rejected without creating a job`() {
        val invalid = validExperiment.replace("\"handlers\": 1", "\"handlers\": 0")

        val response = submit("""{"experiment":$invalid}""")

        assertThat(response.status).isEqualTo(400)
        assertError(response, "INVALID_SUBMISSION", "Invalid experiment submission")
        assertThat(JsonPath.read<List<Map<String, String>>>(response.contentAsString, "$.issues"))
            .containsExactly(
                mapOf(
                    "path" to "variants[0].scenario.services[0].handlers",
                    "message" to "must be greater than zero",
                ),
            )
        verifyNoInteractions(jobManager)
    }

    @Test
    fun `empty body returns sanitized invalid submission without creating a job`() {
        val response = submit("")

        assertThat(response.status).isEqualTo(400)
        assertThat(JsonPath.read<Map<String, Any>>(response.contentAsString, "$"))
            .containsExactlyInAnyOrderEntriesOf(
                mapOf(
                    "code" to "INVALID_SUBMISSION",
                    "message" to "Invalid experiment submission",
                    "issues" to emptyList<Any>(),
                ),
            )
        verifyNoInteractions(jobManager)
    }

    @Test
    fun `job state is returned for a controlled queued job`() {
        val id = UUID.randomUUID()
        given(jobManager.get(id)).willReturn(job(id, ExperimentJobStatus.QUEUED))

        val response = getJob(id)

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<Map<String, Any>>(response.contentAsString, "$"))
            .containsExactlyInAnyOrderEntriesOf(mapOf("id" to id.toString(), "status" to "QUEUED"))
        verify(jobManager).get(id)
    }

    @Test
    fun `unknown job and result return not found`() {
        val id = UUID.randomUUID()
        given(jobManager.get(id)).willReturn(null)

        val jobResponse = getJob(id)
        val resultResponse = getResult(id)

        assertThat(jobResponse.status).isEqualTo(404)
        assertError(jobResponse, "EXPERIMENT_NOT_FOUND", "Experiment not found")
        assertThat(resultResponse.status).isEqualTo(404)
        assertError(resultResponse, "EXPERIMENT_NOT_FOUND", "Experiment not found")
    }

    @Test
    fun `evicted oldest terminal job returns not found while newest remains available`() {
        val manager =
            ExperimentJobManager(
                Executor { throw RejectedExecutionException("capacity") },
                ExperimentExecutor { error("Rejected jobs must not execute") },
            )
        val ids = (1..101).map { manager.submit(rejectedDocument) }
        val api =
            MockMvcBuilders
                .standaloneSetup(ExperimentController(ExperimentService(), manager))
                .setControllerAdvice(ApiExceptionHandler())
                .build()

        val evictedResponse = api.perform(get("/api/v1/experiments/{id}", ids.first())).andReturn().response
        val newestResponse = api.perform(get("/api/v1/experiments/{id}", ids.last())).andReturn().response

        assertThat(evictedResponse.status).isEqualTo(404)
        assertError(evictedResponse, "EXPERIMENT_NOT_FOUND", "Experiment not found")
        assertThat(JsonPath.read<List<Any>>(evictedResponse.contentAsString, "$.issues")).isEmpty()
        assertThat(newestResponse.status).isEqualTo(200)
        assertThat(JsonPath.read<Map<String, Any>>(newestResponse.contentAsString, "$"))
            .containsExactlyInAnyOrderEntriesOf(mapOf("id" to ids.last().toString(), "status" to "FAILED"))
    }

    @Test
    fun `queued and running jobs have no available result`() {
        val id = UUID.randomUUID()
        given(jobManager.get(id)).willReturn(
            job(id, ExperimentJobStatus.QUEUED),
            job(id, ExperimentJobStatus.RUNNING),
        )

        listOf(ExperimentJobStatus.QUEUED, ExperimentJobStatus.RUNNING).forEach { _ ->
            val response = getResult(id)

            assertThat(response.status).isEqualTo(409)
            assertError(response, "EXPERIMENT_NOT_COMPLETED", "Experiment result is not available")
        }
    }

    @Test
    fun `failed job returns only the fixed safe error`() {
        val id = UUID.randomUUID()
        given(jobManager.get(id)).willReturn(
            job(id, ExperimentJobStatus.FAILED).copy(error = "Experiment execution failed"),
        )

        val response = getResult(id)

        assertThat(response.status).isEqualTo(500)
        assertError(response, "EXPERIMENT_FAILED", "Experiment execution failed")
        assertThat(response.contentAsString).doesNotContain(
            "IllegalStateException",
            "stackTrace",
            "Caused by",
            "at resiliencelab",
        )
    }

    @Test
    fun `completed job returns its full result`() {
        val id = UUID.randomUUID()
        val result = ExperimentResult(1, "test-application", "test-ksl", emptyList())
        given(jobManager.get(id)).willReturn(job(id, ExperimentJobStatus.COMPLETED).copy(result = result))

        val response = getResult(id)

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<Map<String, Any>>(response.contentAsString, "$"))
            .containsExactlyInAnyOrderEntriesOf(
                mapOf(
                    "schemaVersion" to 1,
                    "applicationVersion" to "test-application",
                    "kslVersion" to "test-ksl",
                    "variants" to emptyList<Any>(),
                ),
            )
    }

    private fun submit(body: String): MockHttpServletResponse =
        mockMvc
            .perform(post("/api/v1/experiments").contentType(APPLICATION_JSON).content(body))
            .andReturn()
            .response

    private fun getJob(id: UUID): MockHttpServletResponse = mockMvc.perform(get("/api/v1/experiments/{id}", id)).andReturn().response

    private fun getResult(id: UUID): MockHttpServletResponse =
        mockMvc.perform(get("/api/v1/experiments/{id}/result", id)).andReturn().response

    private fun job(
        id: UUID,
        status: ExperimentJobStatus,
    ): ExperimentJob = ExperimentJob(id, status, result = null, error = null)

    private fun assertError(
        response: MockHttpServletResponse,
        code: String,
        message: String,
    ) {
        assertThat(JsonPath.read<String>(response.contentAsString, "$.code")).isEqualTo(code)
        assertThat(JsonPath.read<String>(response.contentAsString, "$.message")).isEqualTo(message)
    }

    private companion object {
        val rejectedDocument =
            ExperimentDocument(
                schemaVersion = 1,
                execution =
                    Execution(
                        replications = 1,
                        warmupMs = 0.0,
                        measurementMs = 1.0,
                        seed = 42,
                        maxRealTimeSeconds = 60,
                    ),
                variants = emptyList(),
            )

        val validExperiment =
            """
            {
              "schemaVersion": 1,
              "execution": {
                "replications": 1,
                "warmupMs": 0.0,
                "measurementMs": 100.0,
                "seed": 42,
                "maxRealTimeSeconds": 10
              },
              "variants": [
                {
                  "id": "baseline",
                  "label": "Baseline",
                  "scenario": {
                    "entry": "entry",
                    "services": [
                      {
                        "id": "entry",
                        "handlers": 1,
                        "queueCapacity": 10,
                        "processing": {"kind": "FIXED", "meanMs": 1.0, "stdDevMs": null},
                        "failureRate": 0.0
                      }
                    ],
                    "links": [],
                    "workload": {"arrivalRate": 0.25, "requestDeadlineMs": 1000.0},
                    "degradation": null
                  },
                  "sweepParameter": null,
                  "sweepValue": null
                }
              ]
            }
            """.trimIndent()
    }
}
