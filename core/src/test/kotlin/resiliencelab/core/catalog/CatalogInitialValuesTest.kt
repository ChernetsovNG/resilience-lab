package resiliencelab.core.catalog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.compiler.ParamReader
import resiliencelab.core.document.BlockInstance
import resiliencelab.core.document.ConnectionInstance
import resiliencelab.core.document.ExecutionSettings
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Variant
import kotlin.test.Test

class CatalogInitialValuesTest {
    private val catalog = Stage1Catalog.catalog
    private val json = Json { encodeDefaults = true }

    private fun initial(param: ParamDescriptor): JsonElement? =
        json.encodeToJsonElement(ParamDescriptor.serializer(), param).jsonObject["initial"]?.takeUnless { it == JsonNull }

    private fun params(type: String) =
        JsonObject(
            catalog
                .type(type)!!
                .params
                .mapNotNull { p -> initial(p)?.let { p.name to it } }
                .toMap(),
        )

    @Test
    fun `every required descriptor including nested fields has an initial value`() {
        fun check(
            params: List<ParamDescriptor>,
            path: String,
        ) {
            params.forEach { param ->
                if (param.required) assertThat(initial(param)).describedAs("%s.%s", path, param.name).isNotNull()
                check(param.fields, "$path.${param.name}")
            }
        }
        catalog.types.forEach { check(it.params, it.id) }
    }

    @Test
    fun `every initial value passes its parameter validation including optional object fields`() {
        val diagnostics = mutableListOf<Diagnostic>()

        fun check(
            params: List<ParamDescriptor>,
            path: String,
        ) {
            params.forEach { param ->
                initial(param)?.let { value ->
                    val reader =
                        ParamReader(JsonObject(mapOf(param.name to value)), listOf(param), "initial.model.json", path, path, diagnostics)
                    when (param.kind) {
                        ParamKind.INTEGER -> reader.int(param.name)
                        ParamKind.NUMBER -> reader.number(param.name)
                        ParamKind.QUANTITY -> reader.quantity(param.name)
                        ParamKind.CHOICE -> reader.choice(param.name)
                        ParamKind.OBJECT -> reader.obj(param.name)
                        ParamKind.ARRAY -> reader.objects(param.name)
                    }
                }
                check(param.fields, "$path/${param.name}")
            }
        }
        catalog.types.forEach { check(it.params, "/${it.id}/params") }
        assertThat(diagnostics).isEmpty()
    }

    @Test
    fun `all block and connection initial values compile without parameter errors`() {
        val model =
            ModelFile(
                schemaVersion = 5,
                blocks = listOf("client", "service", "router", "pooler", "database").associateWith { BlockInstance(it, params(it)) },
                connections =
                    listOf(
                        ConnectionInstance("request", "request", "client", "service", params("request")),
                        ConnectionInstance("call", "call", "service", "router", params("call")),
                        ConnectionInstance("route", "route", "router", "pooler", params("route")),
                        ConnectionInstance("query", "call", "pooler", "database", params("call")),
                    ),
            )
        val experiment =
            ExperimentFile(
                1,
                modelRef = "initial.model.json",
                execution = ExecutionSettings(2, "0s", "1s", 1),
                variants = listOf(Variant("baseline")),
            )
        val result = ModelCompiler().compile(model, "initial.model.json", experiment, "initial.experiment.json")
        assertThat(result.diagnostics.filter { it.code.startsWith("PARAM_") }).isEmpty()
        assertThat(result.experiment).isNotNull()
        assertThat(params("service")["handlers"]).isEqualTo(JsonPrimitive(200))
        assertThat(params("service")["queue"]).isEqualTo(JsonPrimitive(100))
        assertThat(params("database")["maxConnections"]).isEqualTo(JsonPrimitive(100))
        assertThat(params("database")["queue"]).isEqualTo(JsonPrimitive(0))
        assertThat(params("call")).doesNotContainKey("pool")
    }
}
