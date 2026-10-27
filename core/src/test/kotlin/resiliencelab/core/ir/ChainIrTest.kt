package resiliencelab.core.ir

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class ChainIrTest {
    private val fixed = Distribution(DistributionShape.FIXED, 1.0)
    private val chain =
        ChainIr(
            client = ClientNode("client", arrivalRatePerMs = 0.1, deadlineMs = 100.0),
            entry = "a",
            services = listOf(ServiceNode("a", 1, 0, fixed, 0.0), ServiceNode("b", 1, 0, fixed, 0.0)),
            calls =
                listOf(
                    CallEdge(
                        path = "a-to-b",
                        from = "a",
                        to = "b",
                        network = fixed,
                        timeoutMs = 10.0,
                        attempts = 1,
                        backoff = Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0),
                        origin = Origin("m.model.json", "/connections/1"),
                    ),
                ),
            faults = emptyList(),
            run = RunSettings(replications = 1, warmupMs = 0.0, measurementMs = 100.0, seed = 1, maxRealTimeSeconds = 30),
        )

    @Test
    fun `finds the outgoing call of a service`() {
        assertThat(chain.outgoingCall("a")?.path).isEqualTo("a-to-b")
        assertThat(chain.outgoingCall("b")).isNull()
    }

    @Test
    fun `keeps the origin of compiled elements and marks elements built in code`() {
        assertThat(chain.calls.single().origin).isEqualTo(Origin("m.model.json", "/connections/1"))
        assertThat(chain.services.first().origin).isEqualTo(Origin.UNSPECIFIED)
    }
}
