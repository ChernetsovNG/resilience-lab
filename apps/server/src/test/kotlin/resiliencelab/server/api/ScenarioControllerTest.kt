package resiliencelab.server.api

import com.jayway.jsonpath.JsonPath
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post

@WebMvcTest(ScenarioController::class)
@Import(ExperimentService::class)
class ScenarioControllerTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @Test
    fun `valid experiment returns an empty successful validation report`() {
        val response = validate("""{"experiment":$validExperiment}""")

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<Map<String, Any>>(response.contentAsString, "$"))
            .containsExactlyInAnyOrderEntriesOf(mapOf("valid" to true, "issues" to emptyList<Any>()))
    }

    @Test
    fun `valid sweep returns an empty successful validation report`() {
        val response = validate("""{"sweep":$validSweep}""")

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<Map<String, Any>>(response.contentAsString, "$"))
            .containsExactlyInAnyOrderEntriesOf(mapOf("valid" to true, "issues" to emptyList<Any>()))
    }

    @Test
    fun `submission with both experiment and sweep is rejected`() {
        val response = validate("""{"experiment":$validExperiment,"sweep":$validSweep}""")

        assertInvalidSubmission(response)
    }

    @Test
    fun `submission without experiment or sweep is rejected`() {
        val response = validate("{}")

        assertInvalidSubmission(response)
    }

    @Test
    fun `malformed JSON is rejected without internal details`() {
        val response = validate("""{"experiment":""")

        assertInvalidSubmission(response)
    }

    @Test
    fun `unknown submission field is rejected`() {
        val response = validate("""{"experiment":$validExperiment,"unknown":true}""")

        assertInvalidSubmission(response)
    }

    @Test
    fun `unsupported nested schema versions are rejected for experiments and sweeps`() {
        listOf(
            """{"experiment":${validExperiment.replaceSchemaVersion(2)}}""",
            """{"sweep":${validSweep.replaceSchemaVersion(2)}}""",
        ).forEach { submission ->
            assertInvalidSubmission(validate(submission))
        }
    }

    @Test
    fun `invalid experiment returns every core issue with exact paths`() {
        val invalid =
            validExperiment
                .replace("\"handlers\": 1", "\"handlers\": 0")
                .replace("\"requestDeadlineMs\": 100.0", "\"requestDeadlineMs\": 0.0")

        val response = validate("""{"experiment":$invalid}""")

        assertInvalidSubmission(
            response,
            listOf(
                mapOf(
                    "path" to "variants[0].scenario.services[0].handlers",
                    "message" to "must be greater than zero",
                ),
                mapOf(
                    "path" to "variants[0].scenario.workload.requestDeadlineMs",
                    "message" to "must be greater than zero",
                ),
            ),
        )
    }

    @Test
    fun `invalid sweep returns the core preparation issue path`() {
        val invalid = validSweep.replace("\"values\": [1.0, 2.0]", "\"values\": []")

        val response = validate("""{"sweep":$invalid}""")

        assertInvalidSubmission(
            response,
            listOf(mapOf("path" to "sweep.values", "message" to "must not be empty")),
        )
    }

    private fun validate(body: String): MockHttpServletResponse =
        mockMvc
            .perform(
                post("/api/v1/scenarios/validate")
                    .contentType(APPLICATION_JSON)
                    .content(body),
            ).andReturn()
            .response

    private fun assertInvalidSubmission(
        response: MockHttpServletResponse,
        issues: List<Map<String, String>> = emptyList(),
    ) {
        val body = response.contentAsString
        val error: Map<String, Any> = JsonPath.read(body, "$")

        assertThat(response.status).isEqualTo(400)
        assertThat(error).containsExactlyInAnyOrderEntriesOf(
            mapOf(
                "code" to "INVALID_SUBMISSION",
                "message" to "Invalid experiment submission",
                "issues" to issues,
            ),
        )
        assertThat(body).doesNotContain("stackTrace", "exception", "Caused by", "at resiliencelab")
    }

    private fun String.replaceSchemaVersion(version: Int): String = replace("\"schemaVersion\": 1", "\"schemaVersion\": $version")

    private companion object {
        val scenario =
            """
            {
              "entry": "entry",
              "services": [
                {
                  "id": "entry",
                  "handlers": 1,
                  "queueCapacity": 0,
                  "processing": {"kind": "FIXED", "meanMs": 1.0, "stdDevMs": null},
                  "failureRate": 0.0
                }
              ],
              "links": [],
              "workload": {"arrivalRate": 1.0, "requestDeadlineMs": 100.0},
              "degradation": null
            }
            """.trimIndent()

        val validExperiment =
            """
            {
              "schemaVersion": 1,
              "execution": {
                "replications": 1,
                "warmupMs": 0.0,
                "measurementMs": 1000.0,
                "seed": 42,
                "maxRealTimeSeconds": 60
              },
              "variants": [
                {
                  "id": "baseline",
                  "label": "Baseline",
                  "scenario": $scenario,
                  "sweepParameter": null,
                  "sweepValue": null
                }
              ]
            }
            """.trimIndent()

        val validSweep =
            """
            {
              "schemaVersion": 1,
              "execution": {
                "replications": 1,
                "warmupMs": 0.0,
                "measurementMs": 1000.0,
                "seed": 42,
                "maxRealTimeSeconds": 60
              },
              "baseScenario": $scenario,
              "sweep": {
                "parameter": "ARRIVAL_RATE",
                "serviceId": null,
                "linkId": null,
                "values": [1.0, 2.0]
              }
            }
            """.trimIndent()
    }
}
