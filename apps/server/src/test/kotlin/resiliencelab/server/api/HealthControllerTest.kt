package resiliencelab.server.api

import com.jayway.jsonpath.JsonPath
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get

@WebMvcTest(HealthController::class)
class HealthControllerTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @Test
    fun `health returns exact application status and versions`() {
        val response = mockMvc.perform(get("/api/v1/health")).andReturn().response
        val body: Map<String, String> = JsonPath.read(response.contentAsString, "$")

        assertThat(response.status).isEqualTo(200)
        assertThat(body).containsExactlyInAnyOrderEntriesOf(
            mapOf(
                "status" to "ok",
                "applicationVersion" to "0.1.0",
                "kslVersion" to "R1.8.1",
            ),
        )
    }
}
