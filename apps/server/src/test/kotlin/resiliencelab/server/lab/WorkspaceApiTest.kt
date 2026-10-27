package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.LayoutFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Position
import resiliencelab.core.workspace.DocumentVersion
import java.nio.file.Files

@SpringBootTest
@AutoConfigureMockMvc
class WorkspaceApiTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    private val apiJson = Json { encodeDefaults = true }
    private val model = "retry-storm/retry-storm.model.json"
    private val layout = "retry-storm/retry-storm.layout.json"
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
    fun `serves the catalog`() {
        val response = mockMvc.perform(get("/api/v1/catalog")).andReturn().response

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<List<String>>(response.contentAsString, "$.types[*].id"))
            .containsExactly("client", "service", "request", "call")
        openApi.assertResponse("get", "/api/v1/catalog", response)
    }

    @Test
    fun `lists documents with kinds and versions`() {
        val response = mockMvc.perform(get("/api/v1/workspace/documents")).andReturn().response

        val entries = apiJson.decodeFromString(ListSerializer(DocumentEntry.serializer()), response.contentAsString)
        assertThat(entries).contains(
            DocumentEntry(model, DocumentKind.MODEL, version(model)),
            DocumentEntry(layout, DocumentKind.LAYOUT, version(layout)),
            DocumentEntry(experiment, DocumentKind.EXPERIMENT, version(experiment)),
        )
        openApi.assertResponse("get", "/api/v1/workspace/documents", response)
    }

    @Test
    fun `returns a document with its version`() {
        val response = getDocument(model)

        assertThat(response.status).isEqualTo(200)
        assertThat(response.getHeader(HttpHeaders.ETAG)).isEqualTo("\"${version(model)}\"")
        assertThat(JsonPath.read<Int>(response.contentAsString, "$.content.model.blocks.gateway.params.handlers")).isEqualTo(4)
        assertThat(JsonPath.read<Any?>(response.contentAsString, "$.content.layout")).isNull()
        openApi.assertResponse("get", "/api/v1/workspace/document", response)

        val experimentView = getDocument(experiment)
        val attempts = "$.content.experiment.variants[1].overrides['gateway-to-middle.attempts']"
        assertThat(JsonPath.read<Int>(experimentView.contentAsString, attempts)).isEqualTo(1)
        openApi.assertResponse("get", "/api/v1/workspace/document", experimentView)
    }

    @Test
    fun `compares If-Match strongly`() {
        val current = (DocumentCodec.decodeLayout(read(layout), layout) as DecodeResult.Ok).value
        val body = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = current))
        val version = version(layout)

        assertThat(code(putDocument(layout, body, ifMatch = "W/\"$version\""))).isEqualTo("VERSION_CONFLICT")
        assertThat(putDocument(layout, body, ifMatch = "\"stale\", \"$version\"").status).isEqualTo(200)
        assertThat(putDocument(layout, body, ifMatch = "*").status).isEqualTo(200)
        assertThat(code(putDocument("drafts/absent.layout.json", body, ifMatch = "*"))).isEqualTo("VERSION_CONFLICT")
    }

    @Test
    fun `saves canonical documents and guards versions`() {
        val current = (DocumentCodec.decodeLayout(read(layout), layout) as DecodeResult.Ok).value
        val changed = current.copy(positions = current.positions + ("client" to Position(40.0, 100.0)))
        val body = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = changed))
        val before = version(layout)

        val saved = putDocument(layout, body, ifMatch = "\"$before\"")

        assertThat(saved.status).isEqualTo(200)
        assertThat(read(layout)).isEqualTo(DocumentCodec.encodeLayout(changed))
        assertThat(saved.getHeader(HttpHeaders.ETAG)).isEqualTo("\"${version(layout)}\"")
        openApi.assertResponse("put", "/api/v1/workspace/document", saved)

        val stale = putDocument(layout, body, ifMatch = "\"$before\"")
        assertThat(stale.status).isEqualTo(409)
        assertThat(code(stale)).isEqualTo("VERSION_CONFLICT")
        openApi.assertResponse("put", "/api/v1/workspace/document", stale)

        assertThat(code(putDocument(layout, body, ifMatch = null))).isEqualTo("VERSION_REQUIRED")

        val created = putDocument("drafts/new.layout.json", body, ifMatch = null)
        assertThat(created.status).isEqualTo(200)
        assertThat(read("drafts/new.layout.json")).isEqualTo(DocumentCodec.encodeLayout(changed))
    }

    @Test
    fun `rejects wrong kinds, invalid content, bad paths and missing documents`() {
        val modelBody =
            apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(model = ModelFile(schemaVersion = 1, blocks = emptyMap())))
        assertThat(code(putDocument("drafts/x.layout.json", modelBody, ifMatch = null))).isEqualTo("DOCUMENT_KIND")

        val futureBody = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = LayoutFile(schemaVersion = 2)))
        val invalid = putDocument("drafts/future.layout.json", futureBody, ifMatch = null)
        assertThat(invalid.status).isEqualTo(400)
        assertThat(code(invalid)).isEqualTo("DOCUMENT_INVALID")
        assertThat(JsonPath.read<String>(invalid.contentAsString, "$.diagnostics[0].code")).isEqualTo("SCHEMA_VERSION")
        openApi.assertResponse("put", "/api/v1/workspace/document", invalid)

        val malformed =
            mockMvc
                .perform(put("/api/v1/workspace/document").param("path", "drafts/x.layout.json").contentType(APPLICATION_JSON).content("{"))
                .andReturn()
                .response
        assertThat(code(malformed)).isEqualTo("REQUEST_INVALID")

        assertThat(code(getDocument("notes.txt"))).isEqualTo("DOCUMENT_KIND")
        assertThat(code(getDocument("../outside.model.json"))).isEqualTo("DOCUMENT_PATH")
        assertThat(code(getDocument("\u0000.layout.json"))).isEqualTo("DOCUMENT_PATH")

        val missing = getDocument("missing.model.json")
        assertThat(missing.status).isEqualTo(404)
        assertThat(code(missing)).isEqualTo("DOCUMENT_NOT_FOUND")
        openApi.assertResponse("get", "/api/v1/workspace/document", missing)

        Files.writeString(root.resolve("broken.model.json"), "{")
        val broken = getDocument("broken.model.json")
        assertThat(broken.status).isEqualTo(409)
        assertThat(code(broken)).isEqualTo("DOCUMENT_INVALID")
        assertThat(JsonPath.read<String>(broken.contentAsString, "$.diagnostics[0].code")).isEqualTo("JSON_SYNTAX")
    }

    private fun getDocument(path: String): MockHttpServletResponse =
        mockMvc.perform(get("/api/v1/workspace/document").param("path", path)).andReturn().response

    private fun putDocument(
        path: String,
        body: String,
        ifMatch: String?,
    ): MockHttpServletResponse {
        val request = put("/api/v1/workspace/document").param("path", path).contentType(APPLICATION_JSON).content(body)
        ifMatch?.let { request.header(HttpHeaders.IF_MATCH, it) }
        return mockMvc.perform(request).andReturn().response
    }

    private fun code(response: MockHttpServletResponse): String = JsonPath.read(response.contentAsString, "$.code")

    private fun read(path: String): String = Files.readString(root.resolve(path))

    private fun version(path: String): String = DocumentVersion.of(read(path))

    companion object {
        private val root = TestWorkspace.copy()

        @JvmStatic
        @DynamicPropertySource
        fun workspace(registry: DynamicPropertyRegistry) {
            registry.add("resilience-lab.workspace") { root.toString() }
        }
    }
}
