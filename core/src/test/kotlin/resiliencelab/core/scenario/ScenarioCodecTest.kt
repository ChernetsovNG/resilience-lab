package resiliencelab.core.scenario

import kotlinx.serialization.SerializationException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.assertj.core.data.Offset.offset
import kotlin.test.Test

class ScenarioCodecTest {
    @Test
    fun `scenario round trip preserves every configured value`() {
        val base = TestData.simpleScenario()
        val scenario =
            base.copy(
                links =
                    listOf(
                        base.links.single().copy(
                            retry =
                                base.links
                                    .single()
                                    .retry
                                    .copy(base = 3.0),
                        ),
                    ),
            )

        val decoded = ScenarioCodec.decodeScenario(ScenarioCodec.encodeScenario(scenario))

        assertThat(decoded).isEqualTo(scenario)
    }

    @Test
    fun `legacy scenario without retry base decodes with the default`() {
        val encoded = ScenarioCodec.encodeScenario(TestData.simpleScenario())
        assertThat(encoded).doesNotContain("\"base\"")

        val decoded = ScenarioCodec.decodeScenario(encoded)

        assertThat(
            decoded.links
                .single()
                .retry.base,
        ).isCloseTo(2.0, offset(0.0))
    }

    @Test
    fun `experiment round trip preserves schema version and variant metadata`() {
        val document = experimentDocument()

        val decoded = ScenarioCodec.decodeExperiment(ScenarioCodec.encodeExperiment(document))

        assertThat(decoded).isEqualTo(document)
        assertThat(decoded.schemaVersion).isEqualTo(1)
    }

    @Test
    fun `scenario decoder rejects unknown keys`() {
        val encoded = ScenarioCodec.encodeScenario(TestData.simpleScenario())
        val withUnknownKey = encoded.replaceFirst("{", "{\n    \"unexpected\": true,")

        assertThatThrownBy { ScenarioCodec.decodeScenario(withUnknownKey) }
            .isInstanceOf(SerializationException::class.java)
    }

    @Test
    fun `experiment encoder omits null optional fields`() {
        val document =
            experimentDocument().copy(
                variants =
                    listOf(
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

        assertThat(encoded).doesNotContain("\"degradation\"")
        assertThat(encoded).doesNotContain("\"stdDevMs\"")
        assertThat(encoded).doesNotContain("\"sweepParameter\"")
        assertThat(encoded).doesNotContain("\"sweepValue\"")
    }

    @Test
    fun `scenario encoder pretty prints JSON`() {
        val encoded = ScenarioCodec.encodeScenario(TestData.simpleScenario())

        assertThat(encoded).contains("\n    \"entry\": \"entry\"")
    }

    @Test
    fun `experiment decoder rejects unsupported schema versions`() {
        val encoded = ScenarioCodec.encodeExperiment(experimentDocument())

        listOf(0, 2).forEach { version ->
            val unsupported =
                encoded.replaceFirst(
                    "\"schemaVersion\": 1",
                    "\"schemaVersion\": $version",
                )
            assertThatThrownBy { ScenarioCodec.decodeExperiment(unsupported) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `experiment encoder rejects unsupported schema versions`() {
        val document = experimentDocument().copy(schemaVersion = 2)

        assertThatThrownBy { ScenarioCodec.encodeExperiment(document) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `sweep round trip preserves schema version and sweep metadata`() {
        val document = sweepDocument()

        val decoded = ScenarioCodec.decodeSweep(ScenarioCodec.encodeSweep(document))

        assertThat(decoded).isEqualTo(document)
        assertThat(decoded.schemaVersion).isEqualTo(1)
    }

    @Test
    fun `sweep decoder rejects unknown keys`() {
        val encoded = ScenarioCodec.encodeSweep(sweepDocument())
        val withUnknownKey = encoded.replaceFirst("{", "{\n    \"unexpected\": true,")

        assertThatThrownBy { ScenarioCodec.decodeSweep(withUnknownKey) }
            .isInstanceOf(SerializationException::class.java)
    }

    @Test
    fun `sweep decoder rejects unsupported schema versions`() {
        val encoded = ScenarioCodec.encodeSweep(sweepDocument())

        listOf(0, 2).forEach { version ->
            val unsupported =
                encoded.replaceFirst(
                    "\"schemaVersion\": 1",
                    "\"schemaVersion\": $version",
                )
            assertThatThrownBy { ScenarioCodec.decodeSweep(unsupported) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `sweep encoder rejects unsupported schema versions`() {
        val document = sweepDocument().copy(schemaVersion = 2)

        assertThatThrownBy { ScenarioCodec.encodeSweep(document) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    private fun sweepDocument(): SweepDocument =
        SweepDocument(
            schemaVersion = 1,
            execution =
                Execution(
                    replications = 1,
                    warmupMs = 0.0,
                    measurementMs = 1_000.0,
                    seed = 42L,
                    maxRealTimeSeconds = 60L,
                ),
            baseScenario = TestData.simpleScenario(),
            sweep =
                SweepSpec(
                    parameter = SweepParameter.LINK_TIMEOUT,
                    serviceId = null,
                    linkId = "entry-to-backend",
                    values = listOf(25.0, 50.0),
                ),
        )

    private fun experimentDocument(): ExperimentDocument =
        ExperimentDocument(
            schemaVersion = 1,
            execution =
                Execution(
                    replications = 1,
                    warmupMs = 0.0,
                    measurementMs = 1_000.0,
                    seed = 42L,
                    maxRealTimeSeconds = 60L,
                ),
            variants =
                listOf(
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
