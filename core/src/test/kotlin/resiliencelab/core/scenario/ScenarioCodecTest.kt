package resiliencelab.core.scenario

import kotlinx.serialization.SerializationException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ScenarioCodecTest {
    @Test
    fun `scenario round trip preserves every configured value`() {
        val base = TestData.simpleScenario()
        val scenario = base.copy(
            links = listOf(
                base.links.single().copy(retry = base.links.single().retry.copy(base = 3.0)),
            ),
        )

        val decoded = ScenarioCodec.decodeScenario(ScenarioCodec.encodeScenario(scenario))

        assertEquals(scenario, decoded)
    }

    @Test
    fun `legacy scenario without retry base decodes with the default`() {
        val encoded = ScenarioCodec.encodeScenario(TestData.simpleScenario())
        assertFalse(encoded.contains("\"base\""))

        val decoded = ScenarioCodec.decodeScenario(encoded)

        assertEquals(2.0, decoded.links.single().retry.base, 0.0)
    }

    @Test
    fun `experiment round trip preserves schema version and variant metadata`() {
        val document = experimentDocument()

        val decoded = ScenarioCodec.decodeExperiment(ScenarioCodec.encodeExperiment(document))

        assertEquals(document, decoded)
        assertEquals(1, decoded.schemaVersion)
    }

    @Test
    fun `scenario decoder rejects unknown keys`() {
        val encoded = ScenarioCodec.encodeScenario(TestData.simpleScenario())
        val withUnknownKey = encoded.replaceFirst("{", "{\n    \"unexpected\": true,")

        assertFailsWith<SerializationException> {
            ScenarioCodec.decodeScenario(withUnknownKey)
        }
    }

    @Test
    fun `experiment encoder omits null optional fields`() {
        val document = experimentDocument().copy(
            variants = listOf(
                ExperimentVariant(
                    id = "baseline",
                    label = "Baseline",
                    scenario = TestData.simpleScenario(),
                    sweepParameter = null,
                    sweepValue = null,
                ),
            ),
        )

        val encoded = ScenarioCodec.encodeExperiment(document)

        assertFalse(encoded.contains("\"degradation\""))
        assertFalse(encoded.contains("\"stdDevMs\""))
        assertFalse(encoded.contains("\"sweepParameter\""))
        assertFalse(encoded.contains("\"sweepValue\""))
    }

    @Test
    fun `scenario encoder pretty prints JSON`() {
        val encoded = ScenarioCodec.encodeScenario(TestData.simpleScenario())

        assertTrue(encoded.contains("\n    \"entry\": \"entry\""))
    }

    @Test
    fun `experiment decoder rejects unsupported schema versions`() {
        val encoded = ScenarioCodec.encodeExperiment(experimentDocument())

        listOf(0, 2).forEach { version ->
            val unsupported = encoded.replaceFirst(
                "\"schemaVersion\": 1",
                "\"schemaVersion\": $version",
            )
            assertFailsWith<IllegalArgumentException> {
                ScenarioCodec.decodeExperiment(unsupported)
            }
        }
    }

    @Test
    fun `experiment encoder rejects unsupported schema versions`() {
        val document = experimentDocument().copy(schemaVersion = 2)

        assertFailsWith<IllegalArgumentException> {
            ScenarioCodec.encodeExperiment(document)
        }
    }

    @Test
    fun `sweep round trip preserves schema version and sweep metadata`() {
        val document = sweepDocument()

        val decoded = ScenarioCodec.decodeSweep(ScenarioCodec.encodeSweep(document))

        assertEquals(document, decoded)
        assertEquals(1, decoded.schemaVersion)
    }

    @Test
    fun `sweep decoder rejects unknown keys`() {
        val encoded = ScenarioCodec.encodeSweep(sweepDocument())
        val withUnknownKey = encoded.replaceFirst("{", "{\n    \"unexpected\": true,")

        assertFailsWith<SerializationException> {
            ScenarioCodec.decodeSweep(withUnknownKey)
        }
    }

    @Test
    fun `sweep decoder rejects unsupported schema versions`() {
        val encoded = ScenarioCodec.encodeSweep(sweepDocument())

        listOf(0, 2).forEach { version ->
            val unsupported = encoded.replaceFirst(
                "\"schemaVersion\": 1",
                "\"schemaVersion\": $version",
            )
            assertFailsWith<IllegalArgumentException> {
                ScenarioCodec.decodeSweep(unsupported)
            }
        }
    }

    @Test
    fun `sweep encoder rejects unsupported schema versions`() {
        val document = sweepDocument().copy(schemaVersion = 2)

        assertFailsWith<IllegalArgumentException> {
            ScenarioCodec.encodeSweep(document)
        }
    }

    private fun sweepDocument(): SweepDocument = SweepDocument(
        schemaVersion = 1,
        execution = Execution(
            replications = 1,
            warmupMs = 0.0,
            measurementMs = 1_000.0,
            seed = 42L,
            maxRealTimeSeconds = 60L,
        ),
        baseScenario = TestData.simpleScenario(),
        sweep = SweepSpec(
            parameter = SweepParameter.LINK_TIMEOUT,
            serviceId = null,
            linkId = "entry-to-backend",
            values = listOf(25.0, 50.0),
        ),
    )

    private fun experimentDocument(): ExperimentDocument = ExperimentDocument(
        schemaVersion = 1,
        execution = Execution(
            replications = 1,
            warmupMs = 0.0,
            measurementMs = 1_000.0,
            seed = 42L,
            maxRealTimeSeconds = 60L,
        ),
        variants = listOf(
            ExperimentVariant(
                id = "baseline",
                label = "Baseline",
                scenario = TestData.simpleScenario(),
                sweepParameter = SweepParameter.LINK_TIMEOUT,
                sweepValue = 50.0,
            ),
        ),
    )
}
