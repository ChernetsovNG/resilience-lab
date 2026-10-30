package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
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
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
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
            .containsExactly("client", "service", "request", "call", "router", "route")
        assertThat(JsonPath.read<List<String>>(response.contentAsString, "$.assumptions[*]")).isNotEmpty()
        assertThat(JsonPath.read<List<List<String>>>(response.contentAsString, "$.types[*].assumptions"))
            .allSatisfy { assumptions -> assertThat(assumptions).isNotEmpty() }
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
    fun `deletes a document only with the required current If-Match`() {
        val path = "delete/delete-me.layout.json"
        val file = root.resolve(path)
        Files.createDirectories(file.parent)
        Files.copy(root.resolve(layout), file)
        val current = version(path)

        val required = deleteDocument(path, ifMatch = null)
        assertThat(required.status).isEqualTo(428)
        assertThat(code(required)).isEqualTo("VERSION_REQUIRED")
        openApi.assertResponse("delete", "/api/v1/workspace/document", required)

        val missing = deleteDocument("delete/missing.layout.json", ifMatch = "*")
        assertThat(missing.status).isEqualTo(404)
        assertThat(code(missing)).isEqualTo("DOCUMENT_NOT_FOUND")
        openApi.assertResponse("delete", "/api/v1/workspace/document", missing)

        val stale = deleteDocument(path, ifMatch = "\"stale\"")
        assertThat(stale.status).isEqualTo(409)
        assertThat(code(stale)).isEqualTo("VERSION_CONFLICT")
        assertThat(file).exists()
        openApi.assertResponse("delete", "/api/v1/workspace/document", stale)

        val deleted = deleteDocument(path, ifMatch = "\"$current\"")
        assertThat(deleted.status).isEqualTo(204)
        assertThat(deleted.contentAsByteArray).isEmpty()
        assertThat(file).doesNotExist()
        openApi.assertResponse("delete", "/api/v1/workspace/document", deleted)
    }

    @Test
    fun `reports API writes and external document creation modification and deletion`() {
        val initialResponse = getChanges(since = null)
        val initial = decodeChanges(initialResponse)
        assertThat(initial.reset).isFalse()
        assertThat(initial.changes).isEmpty()
        openApi.assertResponse("get", "/api/v1/workspace/changes", initialResponse)

        val current = (DocumentCodec.decodeLayout(read(layout), layout) as DecodeResult.Ok).value
        val body = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = current))
        val apiPath = "changes-api.layout.json"
        assertThat(putDocument(apiPath, body, ifMatch = null).status).isEqualTo(200)
        val api = awaitChange(initial.cursor, apiPath, version(apiPath))
        assertThat(api.reset).isFalse()
        assertThat(api.cursor).isNotEqualTo(initial.cursor)
        assertThat(api.changes.single { it.path == apiPath }.kind).isEqualTo(DocumentKind.LAYOUT)

        val externalPath = "changes-external.model.json"
        val external = root.resolve(externalPath)
        Files.writeString(external, "one\n")
        val created = awaitChange(api.cursor, externalPath, DocumentVersion.of("one\n"))
        assertThat(created.changes.single { it.path == externalPath }.kind).isEqualTo(DocumentKind.MODEL)

        Files.writeString(external, "two\n")
        val updated = awaitChange(created.cursor, externalPath, DocumentVersion.of("two\n"))

        Files.delete(external)
        val deleted = awaitChange(updated.cursor, externalPath, version = null)
        assertThat(deleted.changes.single { it.path == externalPath }.kind).isEqualTo(DocumentKind.MODEL)
    }

    @Test
    fun `rejects malformed change cursors`() {
        listOf("not-a-cursor", "-1").forEach { cursor ->
            val response = getChanges(cursor)

            assertThat(response.status).isEqualTo(400)
            assertThat(code(response)).isEqualTo("CURSOR_INVALID")
            openApi.assertResponse("get", "/api/v1/workspace/changes", response)
        }
    }

    @Test
    fun `rejects wrong kinds, invalid content, bad paths and missing documents`() {
        val modelBody =
            apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(model = ModelFile(schemaVersion = 2, blocks = emptyMap())))
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

    @Test
    fun `structured problem arguments distinguish document kind failures while preserving messages`() {
        val body = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = LayoutFile(schemaVersion = 1)))
        val cases =
            listOf(
                Triple(
                    "get",
                    getDocument("notes.txt"),
                    Pair(
                        "'notes.txt' is not a model, layout or experiment document",
                        """{"reason":"path","path":"notes.txt"}""",
                    ),
                ),
                Triple(
                    "put",
                    putDocument("drafts/x.model.json", body, ifMatch = null),
                    Pair(
                        "Content must hold exactly one document of the kind of 'drafts/x.model.json'",
                        """{"reason":"content","path":"drafts/x.model.json"}""",
                    ),
                ),
            )
        cases.forEach { (method, response, expected) ->
            assertThat(response.status).isEqualTo(400)
            assertThat(code(response)).isEqualTo("DOCUMENT_KIND")
            assertThat(JsonPath.read<String>(response.contentAsString, "$.message")).isEqualTo(expected.first)
            assertThat(Json.parseToJsonElement(response.contentAsString).jsonObject["args"])
                .isEqualTo(Json.parseToJsonElement(expected.second))
            openApi.assertResponse(method, "/api/v1/workspace/document", response)
        }
    }

    @Test
    fun `structured problems carry workspace exception paths and version requirement reasons`() {
        val missing = getDocument("missing.model.json")
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.message")).isEqualTo("Document 'missing.model.json' does not exist")
        assertThat(Json.parseToJsonElement(missing.contentAsString).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"path":"missing.model.json"}"""))

        val outside = getDocument("../outside.model.json")
        assertThat(JsonPath.read<String>(outside.contentAsString, "$.message"))
            .isEqualTo("Path '../outside.model.json' is not a relative path inside the workspace")
        assertThat(Json.parseToJsonElement(outside.contentAsString).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"path":"../outside.model.json"}"""))

        val required = deleteDocument(layout, ifMatch = null)
        assertThat(JsonPath.read<String>(required.contentAsString, "$.message")).isEqualTo("If-Match is required to delete '$layout'")
        assertThat(Json.parseToJsonElement(required.contentAsString).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"reason":"delete","path":"$layout"}"""))

        val content = (DocumentCodec.decodeLayout(read(layout), layout) as DecodeResult.Ok).value
        val body = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = content))
        val exists = putDocument(layout, body, ifMatch = null)
        assertThat(JsonPath.read<String>(exists.contentAsString, "$.message"))
            .isEqualTo("Document '$layout' already exists; send If-Match with its version")
        assertThat(Json.parseToJsonElement(exists.contentAsString).jsonObject["args"])
            .isEqualTo(Json.parseToJsonElement("""{"reason":"create","path":"$layout"}"""))
    }

    @Test
    fun `documents sanitized storage failures in OpenAPI`() {
        Files.write(root.resolve("unreadable.model.json"), byteArrayOf(0xC3.toByte(), 0x28))
        try {
            val response = getDocument("unreadable.model.json")

            assertThat(response.status).isEqualTo(500)
            assertThat(code(response)).isEqualTo("STORAGE_ERROR")
            assertThat(JsonPath.read<String>(response.contentAsString, "$.message")).isEqualTo("Workspace storage failed")
            assertThat(response.contentAsString).doesNotContain(root.toString())
            assertThat(Json.parseToJsonElement(response.contentAsString).jsonObject["args"])
                .isEqualTo(Json.parseToJsonElement("{}"))
            openApi.assertResponse("get", "/api/v1/workspace/document", response)
        } finally {
            Files.deleteIfExists(root.resolve("unreadable.model.json"))
        }
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

    private fun deleteDocument(
        path: String,
        ifMatch: String?,
    ): MockHttpServletResponse {
        val request = delete("/api/v1/workspace/document").param("path", path)
        ifMatch?.let { request.header(HttpHeaders.IF_MATCH, it) }
        return mockMvc.perform(request).andReturn().response
    }

    private fun getChanges(since: String?): MockHttpServletResponse {
        val request = get("/api/v1/workspace/changes")
        since?.let { request.param("since", it) }
        return mockMvc.perform(request).andReturn().response
    }

    private fun decodeChanges(response: MockHttpServletResponse): WorkspaceChangesView =
        apiJson.decodeFromString(WorkspaceChangesView.serializer(), response.contentAsString)

    private fun awaitChange(
        since: String,
        path: String,
        version: String?,
    ): WorkspaceChangesView {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            val response = getChanges(since)
            assertThat(response.status).isEqualTo(200)
            val batch = decodeChanges(response)
            openApi.assertResponse("get", "/api/v1/workspace/changes", response)
            if (batch.changes.any { it.path == path && it.version == version }) return batch
            Thread.sleep(25)
        }
        throw AssertionError("Change '$path' at version '$version' was not observed within five seconds")
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
