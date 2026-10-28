package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunOutcome
import resiliencelab.core.results.SeriesIndex
import resiliencelab.core.workspace.DocumentVersion
import java.nio.file.Files
import java.util.zip.GZIPInputStream

@SpringBootTest
@AutoConfigureMockMvc
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SeriesApiTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var lab: Lab

    private lateinit var run: RunOutcome
    private val runId = "series-api"
    private val indexRoute = "/api/v1/runs/{id}/series/{variant}/{cell}/{rep}"
    private val partRoute = "$indexRoute/{part}"
    private val openApi by lazy {
        OpenApiConformance(
            mockMvc
                .perform(get("/v3/api-docs"))
                .andReturn()
                .response
                .getContentAsString(Charsets.UTF_8),
        )
    }

    @BeforeAll
    fun runExample() {
        run = lab.run("retry-storm/retry-storm.experiment.json", runId)
    }

    @Test
    fun `serves every task index and original gzip part with immutable cache headers`() {
        run.manifest.variants.forEach { variant ->
            repeat(run.manifest.replications) { rep ->
                val directory = root.resolve("${run.runDirectory}/series/$variant/p0/rep-$rep")
                val response = mockMvc.perform(get(indexRoute, runId, variant, "p0", rep)).andReturn().response
                assertThat(response.status).isEqualTo(200)
                assertThat(Json.parseToJsonElement(response.contentAsString))
                    .isEqualTo(Json.parseToJsonElement(Files.readString(directory.resolve("index.json"))))
                openApi.assertResponse("get", indexRoute, response)
                val index = Json.decodeFromString<SeriesIndex>(response.contentAsString)
                assertThat(index.parts).isNotEmpty()
                index.parts.forEach { reference ->
                    val part = reference.file.removePrefix("part-").removeSuffix(".json.gz")
                    val content = mockMvc.perform(get(partRoute, runId, variant, "p0", rep, part)).andReturn().response
                    val stored = Files.readAllBytes(directory.resolve(reference.file))
                    assertThat(content.status).isEqualTo(200)
                    assertThat(content.contentAsByteArray).isEqualTo(stored)
                    assertThat(content.contentType).isEqualTo("application/json")
                    assertThat(content.getHeader("Content-Encoding")).isEqualTo("gzip")
                    assertThat(content.getHeader("ETag")).isEqualTo("\"${reference.sha256}\"")
                    assertThat(DocumentVersion.of(stored)).isEqualTo(reference.sha256)
                    assertThat(content.getHeader("Cache-Control")).contains("max-age=31536000", "public", "immutable")
                    val decoded = GZIPInputStream(content.contentAsByteArray.inputStream()).use { it.readAllBytes() }
                    assertThat(decoded).hasSize(reference.uncompressedBytes)
                    assertThat(decoded).isEqualTo(GZIPInputStream(stored.inputStream()).use { it.readAllBytes() })
                    openApi.assertResponse("get", partRoute, content)
                }
            }
        }
    }

    @Test
    fun `unknown run variant cell replication and part return SERIES_NOT_FOUND`() {
        listOf(
            arrayOf("missing", "baseline", "p0", "0"),
            arrayOf(runId, "missing", "p0", "0"),
            arrayOf(runId, "baseline", "p9", "0"),
            arrayOf(runId, "baseline", "p0", "99"),
        ).forEach { parameters ->
            listOf(indexRoute to parameters, partRoute to (parameters + "0")).forEach { (route, arguments) ->
                val response = mockMvc.perform(get(route, *arguments)).andReturn().response
                assertThat(response.status).isEqualTo(404)
                assertThat(response.contentAsString).contains("\"code\":\"SERIES_NOT_FOUND\"")
                openApi.assertResponse("get", route, response)
            }
        }
        val response = mockMvc.perform(get(partRoute, runId, "baseline", "p0", "0", "99")).andReturn().response
        assertThat(response.status).isEqualTo(404)
        assertThat(response.contentAsString).contains("\"code\":\"SERIES_NOT_FOUND\"")
        openApi.assertResponse("get", partRoute, response)
    }

    @Test
    fun `rejects malformed identifiers and noncanonical or overflowing numbers`() {
        listOf(
            arrayOf("..", "baseline", "p0", "0"),
            arrayOf(runId, "..", "p0", "0"),
            arrayOf(runId, "bad.variant", "p0", "0"),
            arrayOf(runId, "baseline", "point", "0"),
            arrayOf(runId, "baseline", "p01", "0"),
            arrayOf(runId, "baseline", "p0", "-1"),
            arrayOf(runId, "baseline", "p0", "01"),
            arrayOf(runId, "baseline", "p0", "2147483648"),
        ).forEach { parameters ->
            listOf(indexRoute to parameters, partRoute to (parameters + "0")).forEach { (route, arguments) ->
                val response = mockMvc.perform(get(route, *arguments)).andReturn().response
                assertThat(response.status).isEqualTo(400)
                openApi.assertResponse("get", route, response)
            }
        }
        listOf("-1", "01", "2147483648", "index.json").forEach { part ->
            val response = mockMvc.perform(get(partRoute, runId, "baseline", "p0", "0", part)).andReturn().response
            assertThat(response.status).isEqualTo(400)
            openApi.assertResponse("get", partRoute, response)
        }
    }

    @Test
    fun `does not follow series symlinks or index filenames outside the task`() {
        val source = root.resolve("${run.runDirectory}/series/baseline/p0/rep-0")
        val directory = root.resolve("${run.runDirectory}/series/linked/p0/rep-0")
        Files.createDirectories(directory)
        Files.createSymbolicLink(directory.resolve("index.json"), source.resolve("index.json"))
        val linkedIndex = mockMvc.perform(get(indexRoute, runId, "linked", "p0", "0")).andReturn().response
        assertThat(linkedIndex.status).isEqualTo(404)

        Files.delete(directory.resolve("index.json"))
        Files.copy(source.resolve("index.json"), directory.resolve("index.json"))
        Files.createSymbolicLink(directory.resolve("part-0.json.gz"), source.resolve("part-0.json.gz"))
        val linkedPart = mockMvc.perform(get(partRoute, runId, "linked", "p0", "0", "0")).andReturn().response
        assertThat(linkedPart.status).isEqualTo(404)

        Files.delete(directory.resolve("part-0.json.gz"))
        Files.copy(source.resolve("part-0.json.gz"), directory.resolve("part-0.json.gz"))

        Files.writeString(
            directory.resolve("index.json"),
            Files
                .readString(source.resolve("index.json"))
                .replace("part-0.json.gz", "../../../../baseline/p0/rep-0/part-0.json.gz"),
        )
        val escapedPart = mockMvc.perform(get(partRoute, runId, "linked", "p0", "0", "0")).andReturn().response
        assertThat(escapedPart.status).isEqualTo(404)
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
