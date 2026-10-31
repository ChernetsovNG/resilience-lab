package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile

class ClassArrivalsTest {
    private val status = LoadProfile(listOf(LoadPoint(0.0, 0.04), LoadPoint(1_000.0, 0.12)))
    private val checkout = LoadProfile(listOf(LoadPoint(0.0, 0.08), LoadPoint(500.0, 0.02)))

    @Test
    fun `adding a class preserves the exact arrivals of every existing class`() {
        val client = client("mobile", mapOf("status" to status))
        val statusArrivals = run(listOf(client))
        val checkoutArrivals = run(listOf(client.copy(classes = mapOf("checkout" to checkout))))
        val combined = run(listOf(client.copy(classes = mapOf("status" to status, "checkout" to checkout))))

        assertThat(combined).containsExactlyElementsOf((statusArrivals + checkoutArrivals).sorted())
        assertThat(run(listOf(client.copy(classes = mapOf("checkout" to checkout, "status" to status)))))
            .containsExactlyElementsOf(combined)
    }

    @Test
    fun `adding a client preserves exact arrivals even when clients share a class`() {
        val mobile = client("mobile", mapOf("status" to status))
        val partner = client("partner", mapOf("status" to checkout))
        val expected = (run(listOf(mobile)) + run(listOf(partner))).sorted()

        assertThat(run(listOf(mobile, partner))).containsExactlyElementsOf(expected)
        assertThat(run(listOf(partner, mobile))).containsExactlyElementsOf(expected)
    }

    @Test
    fun `explicit class stream cannot collide with a nested client's default stream`() {
        val explicit = client("mobile", mapOf("status" to LoadProfile.constant(0.05)))
        val nested = client("mobile/status", mapOf("default" to LoadProfile.constant(0.05)))
        val explicitArrivals = run(listOf(explicit))
        val nestedArrivals = run(listOf(nested))

        assertThat(explicitArrivals).isNotEqualTo(nestedArrivals)
        assertThat(run(listOf(explicit, nested))).containsExactlyElementsOf((explicitArrivals + nestedArrivals).sorted())
    }

    @Test
    fun `multiple zero load clients and classes finish without arrivals`() {
        val zero = LoadProfile.constant(0.0)
        val clients =
            listOf(
                client("mobile", mapOf("status" to zero, "checkout" to zero)),
                client("partner", mapOf("status" to zero)),
            )

        assertThat(run(clients)).isEmpty()
    }

    private fun client(
        path: String,
        classes: Map<String, LoadProfile>,
    ) = ClientNode(path.split('/'), classes, 500.0, "entry")

    private fun run(clients: List<ClientNode>): List<Double> {
        val base = TestChains.simple()
        val graph =
            base.copy(
                clients = clients,
                services = listOf(base.services.first().copy(handlers = 100, processing = TestChains.fixed(0.0))),
                calls = emptyList(),
                run = base.run.copy(warmupMs = 100.0, measurementMs = 2_000.0),
            )
        return simulate(graph).arrivalTimesMs
    }

    private fun simulate(graph: GraphIr) =
        TestChains.reliabilityModel(Model("ClassArrivalsTest", autoCSVReports = false), graph).runReplication()
}
