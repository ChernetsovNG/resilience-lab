package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.media.JsonSchema
import io.swagger.v3.oas.models.media.ObjectSchema
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.context.annotation.AnnotationConfigApplicationContext
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Primary
import org.springframework.core.env.MapPropertySource
import resiliencelab.core.execution.ExperimentExecutor
import java.nio.file.Files
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS

class LabConfigurationTest {
    @Test
    fun `closing the context cancels a long job and drains its artifact promptly`() {
        val root = TestWorkspace.copy()
        val experiment = "retry-storm/retry-storm.experiment.json"
        val document = root.resolve(experiment)
        Files.writeString(document, Files.readString(document).replace("\"replications\": 10", "\"replications\": 1000"))
        val context = AnnotationConfigApplicationContext()
        context.environment.propertySources.addFirst(MapPropertySource("workspace", mapOf("resilience-lab.workspace" to root.toString())))
        context.register(LabConfiguration::class.java, SingleWorkerConfiguration::class.java)
        context.refresh()
        val closer = Executors.newSingleThreadExecutor()
        try {
            val jobs = context.getBean(JobService::class.java)
            val job = jobs.submit(experiment)
            val deadline = System.nanoTime() + SECONDS.toNanos(30)
            while (jobs.get(job.id)!!.completedTasks == 0) {
                check(System.nanoTime() < deadline) { "Job did not start computing" }
                Thread.sleep(10)
            }
            assertThat(jobs.get(job.id)?.status).isEqualTo(JobStatus.RUNNING)

            val shutdown = closer.submit { context.close() }
            assertThatCode { shutdown.get(5, SECONDS) }.doesNotThrowAnyException()

            val cancelled = jobs.get(job.id)!!
            assertThat(cancelled.status).isEqualTo(JobStatus.CANCELLED)
            assertThat(cancelled.cancelRequested).isTrue()
            val directory = root.resolve(".results/retry-storm/${job.runId}")
            assertThat(JsonPath.read<Boolean>(Files.readString(directory.resolve("manifest.json")), "$.complete")).isFalse()
            assertThat(directory.resolve("summary.json")).doesNotExist()
        } finally {
            closer.shutdownNow()
            closer.awaitTermination(10, SECONDS)
            context.close()
        }
    }

    @Configuration(proxyBeanMethods = false)
    class SingleWorkerConfiguration {
        @Bean
        @Primary
        fun singleWorker(): ExperimentExecutor = ExperimentExecutor(workers = 1)
    }

    @Test
    fun `rejects a missing workspace directory`() {
        assertThatThrownBy { LabConfiguration().workspace("does-not-exist") }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("does not exist")
    }

    @Test
    fun `API JSON writes every property, absent values as null`() {
        val job = JobView("j", "e.experiment.json", "r", JobStatus.QUEUED, 0, 0)

        assertThat(LabConfiguration().apiJson().encodeToString(JobView.serializer(), job)).isEqualTo(
            """{"id":"j","experiment":"e.experiment.json","runId":"r","status":"QUEUED",""" +
                """"completedTasks":0,"totalTasks":0,"cancelRequested":false,"error":null,"diagnostics":[],""" +
                """"errorCode":null,"errorArgs":null}""",
        )
    }

    @Test
    fun `nullable enums accept null in the schema`() {
        val dimension = JsonSchema().types(setOf("string", "null"))
        dimension.enum = listOf("DURATION", "RATE")
        val required = JsonSchema().types(setOf("string"))
        required.enum = listOf("ERROR", "WARNING")
        val descriptor = ObjectSchema().addProperty("dimension", dimension).addProperty("severity", required)
        val openApi = OpenAPI().components(Components().addSchemas("Descriptor", descriptor))

        LabConfiguration().nullableEnums().customise(openApi)

        assertThat(dimension.enum).containsExactly("DURATION", "RATE", null)
        assertThat(required.enum).containsExactly("ERROR", "WARNING")
    }
}
