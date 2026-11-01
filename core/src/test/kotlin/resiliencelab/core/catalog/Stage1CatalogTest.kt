package resiliencelab.core.catalog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.results.ConnectionWindowMetrics
import resiliencelab.core.results.WindowMetrics
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.Test

class Stage1CatalogTest {
    private val catalog = Stage1Catalog.catalog
    private val json = Json { encodeDefaults = true }

    @Test
    fun `connection output measures retries per call independently of traffic share`() {
        val output = catalog.type("call")!!.outputs.firstOrNull { it.id == "attemptsPerCall" }
        assertThat(output).isNotNull()
        val calculation = output!!.calculation
        assertThat(calculation.kind.name).isEqualTo("RATIO_TO_DIFFERENCE")
        listOf(Triple(10, 0, 1.0), Triple(27, 17, 2.7), Triple(0, 0, null), Triple(5, 5, null)).forEach { (sent, retries, expected) ->
            val row =
                json
                    .encodeToJsonElement(
                        ConnectionWindowMetrics.serializer(),
                        ConnectionWindowMetrics(0.0, 100.0, sentAttempts = sent, retries = retries),
                    ).jsonObject
            val numerator = row.getValue(calculation.field).toString().toDouble()
            val denominator = numerator - row.getValue(calculation.divisor!!).toString().toDouble()
            assertThat(if (denominator > 0) numerator / denominator else null).isEqualTo(expected)
        }
        assertThat(output.summary!!.calculation.field).isEqualTo("totals.sentAttempts")
        assertThat(output.summary.calculation.divisor).isEqualTo("totals.retries")
        assertThat(catalog.type("request")!!.outputs.first { it.id == "attemptsPerCall" }).isEqualTo(output)
    }

    @Test
    fun `policy outputs are available to the element inspector`() {
        val expected =
            mapOf(
                "call" to listOf("circuitOpenShare", "circuitRejectionsPerSecond", "retriesDeniedPerSecond", "fallbacksPerSecond"),
                "service" to
                    listOf(
                        "rateLimitedPerSecond",
                        "rateLimitedRate",
                        "probeFailuresPerSecond",
                        "notReadyShare",
                        "ejectionsCount",
                        "ejectedShare",
                    ),
                "client" to listOf("degradedPerSecond"),
            )
        expected.forEach { (type, ids) ->
            ids.forEach { id ->
                val output = catalog.type(type)!!.outputs.first { it.id == id }
                assertThat(output.inspector?.showValue).describedAs("%s.%s", type, id).isTrue()
            }
        }
    }

    @Test
    fun `every type declares its outputs in the serialized catalog`() {
        val types =
            json
                .encodeToJsonElement(Catalog.serializer(), catalog)
                .jsonObject
                .getValue("types")
                .jsonArray
        assertThat(types).allSatisfy { type ->
            assertThat(type.jsonObject["outputs"]?.jsonArray).isNotNull()
        }
    }

    @Test
    fun `output identifiers are unique and calculations reference existing fields`() {
        val node =
            json
                .encodeToJsonElement(
                    WindowMetrics.serializer(),
                    WindowMetrics(
                        0.0,
                        100.0,
                        slotPools =
                            listOf("handlers", "clientConnections", "serverConnections").associateWith {
                                resiliencelab.core.experiment.SlotPoolMetrics(
                                    replicaExtrema = resiliencelab.core.experiment.ReplicaSlotExtrema(0.0, 0.0, 1, 0.0, 0.0, 1),
                                )
                            },
                    ),
                ).jsonObject
        val connection =
            json
                .encodeToJsonElement(
                    ConnectionWindowMetrics.serializer(),
                    ConnectionWindowMetrics(
                        0.0,
                        100.0,
                        slotPools =
                            mapOf(
                                "pool" to
                                    resiliencelab.core.experiment.SlotPoolMetrics(
                                        replicaExtrema = resiliencelab.core.experiment.ReplicaSlotExtrema(0.0, 0.0, 1, 0.0, 0.0, 1),
                                    ),
                            ),
                    ),
                ).jsonObject
        catalog.types.forEach { type ->
            assertThat(type.outputs.map { it.id }).doesNotHaveDuplicates()
            type.outputs.forEach { output ->
                val calculation = output.calculation
                listOfNotNull(calculation.field, calculation.divisor, calculation.capacity).forEach { path ->
                    val parts = path.split('.')
                    if (parts.first() == "params") {
                        assertThat(type.params.map { it.name }).contains(parts[1])
                    } else {
                        val scoped = parts.first() == "target"
                        val entryTotal = parts.take(2) == listOf("entries", "total")
                        var field: JsonElement? = if (scoped || entryTotal || type.category == TypeCategory.BLOCK) node else connection
                        val fields =
                            when {
                                scoped -> parts.drop(1)
                                entryTotal -> parts.drop(2)
                                else -> parts
                            }
                        for (part in fields) field = field?.jsonObject?.get(part)
                        assertThat(field).describedAs("%s.%s references %s", type.id, output.id, path).isNotNull()
                    }
                }
                if (calculation.kind == OutputCalculationKind.QUANTILE) {
                    assertThat(calculation.percentile).isIn(0.5, 0.95, 0.99)
                }
            }
        }
    }

    @Test
    fun `request has no own series and summary populations retain their semantics`() {
        assertThat(catalog.type("request")!!.outputs).allSatisfy { output ->
            assertThat(output.timeline).isNull()
            assertThat(output.inspector).isNotNull()
        }
        val residence = catalog.type("service")!!.outputs.first { it.id == "meanLatencyMs" }
        assertThat(residence.summary!!.source).isEqualTo(OutputSummarySource.REPLICATION)
        assertThat(residence.summary!!.intervalField).isNull()
        val timeout = catalog.type("call")!!.outputs.first { it.id == "timeoutRate" }
        assertThat(timeout.summary!!.intervalField).isEqualTo("timeoutRate")
    }

    @Test
    fun `contains the stage 1 block and connection types`() {
        assertThat(
            catalog.types.map { it.id },
        ).containsExactly("client", "service", "request", "call", "router", "route", "database", "pooler", "cache")
        assertThat(catalog.type("client")!!.category).isEqualTo(TypeCategory.BLOCK)
        assertThat(
            catalog.type("call")!!.connects,
        ).isEqualTo(ConnectionRule(listOf("service", "pooler"), listOf("service", "router", "database", "pooler", "cache")))
        assertThat(catalog.type("request")!!.connects).isEqualTo(ConnectionRule(listOf("client"), listOf("service")))
        assertThat(catalog.type("unknown")).isNull()
    }

    @Test
    fun `describes required service parameters with units and ranges`() {
        val params = catalog.type("service")!!.params.associateBy { it.name }
        assertThat(params.keys).containsExactly("handlers", "queue", "processing", "failureRate", "replicas", "rateLimit", "healthCheck")
        assertThat(params.getValue("replicas").default).isEqualTo(JsonPrimitive(1))
        assertThat(params.getValue("replicas").minimum).isEqualTo(1.0)
        assertThat(params.getValue("replicas").sweepable).isTrue()
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
        assertThat(
            shared,
        ).contains("arriving during measurement", "after measurement ends", "when they occur", "0.78125%", "Student", "not clipped")
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

    @Test
    fun `web catalog fixture matches the core catalog including outputs`() {
        val fixture = Json.decodeFromString(Catalog.serializer(), Path.of("../web/src/test/catalog.json").readText())
        assertThat(fixture).isEqualTo(catalog)
    }

    @Test
    fun `database retains calculations and names connections and query queues in every view`() {
        val service = catalog.type("service")!!.outputs.associateBy { it.id }
        val databaseType = catalog.type("database")!!
        val database = databaseType.outputs
        database.filter { it.overlay != null }.forEach { output ->
            assertThat(output.calculation).describedAs(output.id).isEqualTo(service.getValue(output.id).calculation)
            assertThat(output.overlay!!.title).describedAs(output.id).isEqualTo(service.getValue(output.id).overlay!!.title)
            assertThat(output.overlay.description).doesNotContain("handler", "Handler")
        }
        val utilization = database.first { it.id == "utilization" }
        assertThat(utilization.title).isEqualTo("Connection utilization")
        assertThat(utilization.inspector!!.title).isEqualTo("Connection utilization")
        assertThat(utilization.overlay!!.label).isEqualTo("Connections {value}")
        val queue = database.first { it.id == "meanQueue" }
        assertThat(queue.timeline!!.groupTitle).isEqualTo("Query queue")
        assertThat(queue.overlay!!.label).isEqualTo("Queue {value}")
        assertThat(databaseType.params.first { it.name == "maxConnections" }.title).isEqualTo("Maximum connections")
    }
}
