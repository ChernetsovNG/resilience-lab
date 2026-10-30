package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.ir.LoadProfile
import kotlin.test.Test

class TestChainsTest {
    @Test
    fun `expected arrivals are exactly the arrivals the engine draws`() {
        val base = TestChains.simple()
        val chain =
            base.copy(
                client = base.client.copy(load = LoadProfile.constant(0.25)),
                services = listOf(base.services.first().copy(processing = TestChains.fixed(0.0), queueCapacity = 1_000)),
                calls = emptyList(),
                run = TestChains.run(measurementMs = 100.0),
            )

        val result = TestChains.reliabilityModel(Model("TestChainsTest", autoCSVReports = false), chain).runReplication()

        assertThat(result.arrivalTimesMs).isNotEmpty()
        assertThat(result.arrivalTimesMs).isEqualTo(TestChains.expectedArrivals(seed = 42L, arrivalRatePerMs = 0.25, endMs = 100.0))
    }

    @Test
    fun `streams differ by replication and role`() {
        val first = TestChains.stream(42L, "entry", StreamRole.PROCESSING).randU01()

        assertThat(TestChains.stream(42L, "entry", StreamRole.PROCESSING).randU01()).isEqualTo(first)
        assertThat(TestChains.stream(42L, "entry", StreamRole.PROCESSING, replication = 1).randU01()).isNotEqualTo(first)
        assertThat(TestChains.stream(42L, "entry", StreamRole.OUTCOME).randU01()).isNotEqualTo(first)
    }
}
