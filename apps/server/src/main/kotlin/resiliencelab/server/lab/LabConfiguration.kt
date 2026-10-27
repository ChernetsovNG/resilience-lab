package resiliencelab.server.lab

import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.media.JsonSchema
import io.swagger.v3.oas.models.media.Schema
import io.swagger.v3.oas.models.servers.Server
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.springdoc.core.customizers.OpenApiCustomizer
import org.springdoc.core.utils.SpringDocUtils
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunIds
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.results.Versions
import resiliencelab.core.workspace.FileWorkspace
import resiliencelab.core.workspace.Workspace
import java.nio.file.Files
import java.nio.file.Path

/**
 * Beans of the stage 1 API (ADR 0010): the workspace directory, the core [Lab], jobs, and the JSON and OpenAPI
 * settings that keep kotlinx responses and the springdoc schema in agreement.
 */
@Configuration(proxyBeanMethods = false)
class LabConfiguration {
    init {
        // Any JSON value. An empty schema is emitted as `type: object` and would reject numbers and strings.
        val anyJson = JsonSchema().types(setOf("array", "boolean", "integer", "null", "number", "object", "string"))
        SpringDocUtils
            .getConfig()
            .replaceWithSchema(JsonObject::class.java, JsonSchema().types(setOf("object")).additionalProperties(true))
            .replaceWithSchema(JsonElement::class.java, anyJson.additionalProperties(true))
    }

    /** Adds `null` to the `enum` of nullable enum properties: springdoc lists only the constants (JSON Schema 2020-12). */
    @Bean
    fun nullableEnums(): OpenApiCustomizer =
        OpenApiCustomizer { openApi ->
            openApi.components?.schemas?.values?.forEach { schema ->
                schema.properties?.values?.forEach { property ->
                    @Suppress("UNCHECKED_CAST")
                    val typed = property as Schema<Any?>
                    val values = typed.enum
                    if (typed.types?.contains("null") == true && values != null && null !in values) typed.enum = values + null
                }
            }
        }

    /**
     * JSON of `@Serializable` requests and responses, picked up by the Spring Boot kotlinx converter. Every property is
     * written and absent values are `null`, so a response holds exactly what the schema marks as required.
     */
    @Bean
    fun apiJson(): Json = Json { encodeDefaults = true }

    @Bean
    fun openApi(): OpenAPI =
        OpenAPI()
            .info(Info().title("resilience-lab API").version(Versions.APPLICATION))
            .servers(listOf(Server().url("/")))

    /** The workspace directory from `resilience-lab.workspace` or `RESILIENCE_LAB_WORKSPACE`; it must exist. */
    @Bean
    fun workspace(
        @Value("\${resilience-lab.workspace}") directory: String,
    ): Workspace {
        val root = Path.of(directory).toAbsolutePath().normalize()
        check(Files.isDirectory(root)) { "Workspace directory $root does not exist" }
        return FileWorkspace(root)
    }

    /** One pool of simulation tasks for all jobs (ADR 0009); Spring closes it with the context. */
    @Bean
    fun experimentExecutor(): ExperimentExecutor = ExperimentExecutor()

    @Bean
    fun lab(
        workspace: Workspace,
        experimentExecutor: ExperimentExecutor,
    ): Lab = Lab(workspace, executor = experimentExecutor)

    @Bean
    fun runCatalog(workspace: Workspace): RunCatalog = RunCatalog(workspace)

    /** One job at a time; each job spreads its tasks over the core pool (stage 1 slice: no interleaving). */
    @Bean
    fun labJobExecutor(): ThreadPoolTaskExecutor =
        ThreadPoolTaskExecutor().apply {
            setCorePoolSize(1)
            setMaxPoolSize(1)
            setQueueCapacity(100)
            setThreadNamePrefix("lab-job-")
            setWaitForTasksToCompleteOnShutdown(true)
            setAwaitTerminationSeconds(30)
        }

    @Bean
    fun jobService(
        lab: Lab,
        @Qualifier("labJobExecutor") executor: ThreadPoolTaskExecutor,
    ): JobService = JobService(lab, executor) { RunIds.next() }
}
