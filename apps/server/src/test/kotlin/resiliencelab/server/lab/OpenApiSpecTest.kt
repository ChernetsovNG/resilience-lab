package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping
import java.nio.file.Files
import java.nio.file.Path

/**
 * The committed `apps/server/openapi.json` must equal the document generated from the code (ADR 0010, item 2).
 * Regenerate with `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`.
 */
@SpringBootTest
@AutoConfigureMockMvc
class OpenApiSpecTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var handlerMapping: RequestMappingHandlerMapping

    private val file = Path.of("openapi.json")

    private fun generated(): String =
        mockMvc
            .perform(get("/v3/api-docs"))
            .andReturn()
            .response
            .getContentAsString(Charsets.UTF_8)
            .replace("\r\n", "\n") + "\n"

    @Test
    fun `committed OpenAPI document matches the code`() {
        val generated = generated()
        if (System.getenv("UPDATE_OPENAPI") == "1") Files.writeString(file, generated)

        assertThat(file).exists()
        assertThat(Files.readString(file)).describedAs("apps/server/openapi.json is stale; regenerate it").isEqualTo(generated)
    }

    @Test
    fun `registered API operations match the committed contract`() {
        val methods = RequestMethod.entries.map { it.name.lowercase() }.toSet()
        val documented =
            Json
                .parseToJsonElement(Files.readString(file))
                .jsonObject
                .getValue("paths")
                .jsonObject
                .flatMap { (path, item) ->
                    item.jsonObject.keys
                        .filter { it in methods }
                        .map { "${it.uppercase()} $path" }
                }
        val registered =
            handlerMapping.handlerMethods.keys.flatMap { mapping ->
                mapping.patternValues.filter { it.startsWith("/api/v1/") }.flatMap { path ->
                    mapping.methodsCondition.methods
                        .ifEmpty { RequestMethod.entries.toSet() }
                        .map { "${it.name} $path" }
                }
            }

        assertThat(registered).containsExactlyInAnyOrderElementsOf(documented)
    }

    @Test
    fun `document covers exactly the stage 1 API`() {
        val document = Json.parseToJsonElement(generated()).jsonObject
        val schemas =
            document
                .getValue("components")
                .jsonObject
                .getValue("schemas")
                .jsonObject

        assertThat(document.getValue("paths").jsonObject.keys).containsExactlyInAnyOrder(
            "/api/v1/catalog",
            "/api/v1/health",
            "/api/v1/jobs",
            "/api/v1/jobs/{id}",
            "/api/v1/runs",
            "/api/v1/runs/{id}/manifest",
            "/api/v1/runs/{id}/summary",
            "/api/v1/validate",
            "/api/v1/workspace/document",
            "/api/v1/workspace/documents",
        )
        assertThat(schemas.keys).contains("ApiProblem", "BlockInstance", "JobView", "RunSummary").doesNotContain("ApiError")
        val params =
            schemas
                .getValue("BlockInstance")
                .jsonObject
                .getValue("properties")
                .jsonObject
                .getValue("params")
                .jsonObject
        assertThat(params.getValue("additionalProperties").toString()).isEqualTo("true")
    }
}
