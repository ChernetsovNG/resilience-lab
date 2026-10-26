package resiliencelab.server.api

import com.jayway.jsonpath.JsonPath
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.fail
import org.assertj.core.data.Offset.offset
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.util.UUID
import java.util.concurrent.TimeUnit.MILLISECONDS
import java.util.concurrent.TimeUnit.SECONDS

@SpringBootTest
@AutoConfigureMockMvc
class RealExperimentApiTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @Test
    fun `submitted experiment completes asynchronously with its real KSL result`() {
        val submitted =
            mockMvc
                .perform(
                    post("/api/v1/experiments")
                        .contentType(APPLICATION_JSON)
                        .content("""{"experiment":$shortExperiment}"""),
                ).andReturn()
                .response

        assertThat(submitted.status).isEqualTo(202)
        assertThat(JsonPath.read<String>(submitted.contentAsString, "$.status")).isEqualTo("QUEUED")
        val id = UUID.fromString(JsonPath.read(submitted.contentAsString, "$.id"))
        awaitCompleted(id)

        val response =
            mockMvc
                .perform(get("/api/v1/experiments/{id}/result", id))
                .andReturn()
                .response
        val body = response.contentAsString

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<Int>(body, "$.schemaVersion")).isEqualTo(1)
        assertThat(JsonPath.read<String>(body, "$.applicationVersion")).isEqualTo("0.1.0")
        assertThat(JsonPath.read<String>(body, "$.kslVersion")).isEqualTo("R1.8.1")
        assertThat(JsonPath.read<List<Any>>(body, "$.variants")).hasSize(1)
        assertThat(JsonPath.read<String>(body, "$.variants[0].id")).isEqualTo("baseline")

        val successes = JsonPath.read<Int>(body, "$.variants[0].replications[0].successes")
        assertThat(successes).isPositive()
        assertThat(JsonPath.read<Int>(body, "$.variants[0].replications[0].originalArrivals"))
            .isEqualTo(successes)
        assertThat(JsonPath.read<Int>(body, "$.variants[0].replications[0].failures")).isZero()

        val p95 = JsonPath.read<Double>(body, "$.variants[0].aggregate.pooledLatency.all.p95Ms")
        val p99 = JsonPath.read<Double>(body, "$.variants[0].aggregate.pooledLatency.all.p99Ms")
        assertThat(p95).isPositive()
        assertThat(p99).isGreaterThanOrEqualTo(p95)
        assertThat(
            JsonPath.read<Double>(
                body,
                "$.variants[0].aggregate.services.entry.admittedAmplification.mean",
            ),
        ).isCloseTo(1.0, offset(0.000001))
        assertThat(
            JsonPath.read<Double>(
                body,
                "$.variants[0].aggregate.services.entry.offeredAmplification.mean",
            ),
        ).isCloseTo(1.0, offset(0.000001))
    }

    private fun awaitCompleted(id: UUID) {
        val deadline = System.nanoTime() + SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            val response =
                mockMvc
                    .perform(get("/api/v1/experiments/{id}", id))
                    .andReturn()
                    .response
            assertThat(response.status).isEqualTo(200)
            when (JsonPath.read<String>(response.contentAsString, "$.status")) {
                "COMPLETED" -> return
                "FAILED" -> fail("Experiment job $id failed before producing a result")
                else -> MILLISECONDS.sleep(10)
            }
        }
        fail<Nothing>("Experiment job $id did not complete within 15 seconds")
    }

    private companion object {
        val shortExperiment =
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
