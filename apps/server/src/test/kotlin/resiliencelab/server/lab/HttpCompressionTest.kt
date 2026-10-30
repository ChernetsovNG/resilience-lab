package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunOutcome
import resiliencelab.core.workspace.DocumentVersion
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.time.Duration
import java.util.zip.GZIPInputStream

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class HttpCompressionTest {
    @LocalServerPort
    private var port: Int = 0

    @Autowired
    private lateinit var lab: Lab

    private lateinit var run: RunOutcome
    private val runId = "http-compression"

    @BeforeAll
    fun runExample() {
        run = lab.run("retry-storm/retry-storm.experiment.json", runId)
    }

    @Test
    fun `compresses run summary only when gzip is accepted`() {
        val plain = get("/runs/$runId/summary")
        assertThat(plain.statusCode()).isEqualTo(200)
        assertThat(plain.headers().allValues("Content-Encoding")).isEmpty()
        assertThat(plain.body().size).isGreaterThan(1024)
        val compressed = get("/runs/$runId/summary", "gzip")
        assertThat(compressed.statusCode()).isEqualTo(200)
        assertThat(compressed.headers().allValues("Content-Encoding")).containsExactly("gzip")
        assertThat(compressed.body().size).isLessThan(plain.body().size)
        assertThat(decompress(compressed.body())).isEqualTo(plain.body())
    }

    @Test
    fun `keeps small JSON responses uncompressed`() {
        val response = get("/health", "gzip")
        assertThat(response.statusCode()).isEqualTo(200)
        assertThat(response.body().size).isLessThan(1024)
        assertThat(response.headers().allValues("Content-Encoding")).isEmpty()
        assertThat(Json.parseToJsonElement(response.body().toString(Charsets.UTF_8)))
            .isEqualTo(Json.parseToJsonElement(get("/health").body().toString(Charsets.UTF_8)))
    }

    @Test
    fun `compresses large problem JSON responses`() {
        val path = "/runs/${"missing".repeat(200)}/summary"
        val plain = get(path, accept = "application/problem+json")
        assertThat(plain.statusCode()).isEqualTo(404)
        assertThat(plain.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
        assertThat(plain.body().size).isGreaterThan(1024)

        val compressed = get(path, "gzip", "application/problem+json")
        assertThat(compressed.statusCode()).isEqualTo(404)
        assertThat(compressed.headers().allValues("Content-Encoding")).containsExactly("gzip")
        assertThat(decompress(compressed.body())).isEqualTo(plain.body())
    }

    @Test
    fun `serves series parts with one gzip encoding and original bytes`() {
        val stored = Files.readAllBytes(root.resolve("${run.runDirectory}/series/baseline/p0/rep-0/part-0.json.gz"))
        assertThat(stored.size).isGreaterThan(1024)

        listOf(null, "gzip").forEach { encoding ->
            val response = get("/runs/$runId/series/baseline/p0/0/0", encoding)
            assertThat(response.statusCode()).isEqualTo(200)
            assertThat(response.headers().allValues("Content-Encoding")).containsExactly("gzip")
            assertThat(response.headers().firstValue("ETag").orElse("")).isEqualTo("\"${DocumentVersion.of(stored)}\"")
            assertThat(response.headers().firstValue("Cache-Control").orElse(""))
                .contains("max-age=31536000", "public", "immutable")
            assertThat(response.body()).isEqualTo(stored)
            Json.parseToJsonElement(decompress(response.body()).toString(Charsets.UTF_8))
        }
    }

    private fun get(
        path: String,
        encoding: String? = null,
        accept: String = "application/json",
    ): HttpResponse<ByteArray> {
        val request =
            HttpRequest
                .newBuilder(URI("http://127.0.0.1:$port/api/v1$path"))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", accept)
                .GET()
        encoding?.let { request.header("Accept-Encoding", it) }
        return HttpClient.newHttpClient().use { client -> client.send(request.build(), HttpResponse.BodyHandlers.ofByteArray()) }
    }

    private fun decompress(bytes: ByteArray): ByteArray = GZIPInputStream(bytes.inputStream()).use { it.readAllBytes() }

    companion object {
        private val root = TestWorkspace.copy()

        @JvmStatic
        @DynamicPropertySource
        fun workspace(registry: DynamicPropertyRegistry) {
            registry.add("resilience-lab.workspace") { root.toString() }
        }
    }
}
