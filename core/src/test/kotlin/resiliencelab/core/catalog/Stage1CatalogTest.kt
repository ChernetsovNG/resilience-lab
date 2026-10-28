package resiliencelab.core.catalog

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class Stage1CatalogTest {
    private val catalog = Stage1Catalog.catalog

    @Test
    fun `contains the stage 1 block and connection types`() {
        assertThat(catalog.types.map { it.id }).containsExactly("client", "service", "request", "call")
        assertThat(catalog.type("client")!!.category).isEqualTo(TypeCategory.BLOCK)
        assertThat(catalog.type("call")!!.connects).isEqualTo(ConnectionRule("service", "service"))
        assertThat(catalog.type("request")!!.connects).isEqualTo(ConnectionRule("client", "service"))
        assertThat(catalog.type("unknown")).isNull()
    }

    @Test
    fun `describes required service parameters with units and ranges`() {
        val params = catalog.type("service")!!.params.associateBy { it.name }
        assertThat(params.keys).containsExactly("handlers", "queue", "processing", "failureRate")
        assertThat(params.getValue("handlers").required).isTrue()
        assertThat(params.getValue("handlers").minimum).isEqualTo(1.0)
        assertThat(params.getValue("failureRate").dimension).isEqualTo(Dimension.PROBABILITY)
        assertThat(params.getValue("failureRate").units).containsExactly(QuantityUnit("%", 1.0, 100.0))
        assertThat(params.getValue("handlers").units).isEmpty()
        val mean = params.getValue("processing").fields.first { it.name == "mean" }
        assertThat(mean.units.map { it.symbol }).containsExactly("ms", "s", "min")
        assertThat(params.getValue("processing").fields.map { it.name }).containsExactly("kind", "mean", "stdDev")
    }

    @Test
    fun `documents model and measurement assumptions`() {
        val shared = catalog.assumptions.joinToString("\n")
        assertThat(shared).contains("cohort", "run-out", "event-time", "0.78125%", "Student", "not clipped")
        assertThat(catalog.types).allSatisfy { type -> assertThat(type.assumptions).isNotEmpty() }

        val service = catalog.type("service")!!.assumptions.joinToString("\n")
        assertThat(service).contains("handler", "downstream", "backoff")
        val call = catalog.type("call")!!.assumptions.joinToString("\n")
        assertThat(call).contains("orphaned work", "Late responses", "does not cancel")
    }

    @Test
    fun `survives a JSON round trip`() {
        val json = Json.encodeToString(Catalog.serializer(), catalog)
        assertThat(Json.decodeFromString(Catalog.serializer(), json)).isEqualTo(catalog)
    }
}
