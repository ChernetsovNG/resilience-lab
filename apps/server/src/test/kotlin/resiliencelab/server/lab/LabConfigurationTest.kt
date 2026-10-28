package resiliencelab.server.lab

import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.media.JsonSchema
import io.swagger.v3.oas.models.media.ObjectSchema
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class LabConfigurationTest {
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
                """"completedTasks":0,"totalTasks":0,"cancelRequested":false,"error":null,"diagnostics":[]}""",
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
