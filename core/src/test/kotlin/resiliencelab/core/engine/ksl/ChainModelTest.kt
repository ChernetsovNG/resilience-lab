package resiliencelab.core.engine.ksl

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import kotlin.test.Test

class ChainModelTest {
    private fun chain(faults: List<FaultSpan> = emptyList()) =
        GraphIr(
            client = ClientNode("client", arrivalRatePerMs = 0.05, deadlineMs = 200.0),
            entry = "front",
            services =
                listOf(
                    ServiceNode("back", 1, 4, Distribution(DistributionShape.EXPONENTIAL, 5.0), 0.01),
                    ServiceNode("front", 2, 4, Distribution(DistributionShape.FIXED, 1.0), 0.0),
                ),
            calls =
                listOf(
                    CallEdge(
                        path = "front-to-back",
                        from = "front",
                        to = "back",
                        network = Distribution(DistributionShape.FIXED, 0.5),
                        timeoutMs = 20.0,
                        attempts = 2,
                        backoff = Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 1.0, 5.0, 2.0),
                    ),
                ),
            faults = faults,
            run = RunSettings(replications = 2, warmupMs = 0.0, measurementMs = 500.0, seed = 7, maxRealTimeSeconds = 30),
        )

    private fun run(
        chain: GraphIr,
        replication: Int,
    ): ReplicationResult {
        val plan = StreamPlan(PathStreams.keys(chain, replication))
        val model = Model("ChainModelTest", autoCSVReports = false)
        return ReliabilityModel(model, chain, PathStreamSource(plan, chain.run.seed, replication.toLong())).runReplication()
    }

    @Test
    fun `runs a replication to full drain and repeats it exactly`() {
        val chain = chain()

        val first = run(chain, replication = 0)

        assertThat(first.originalArrivals).isGreaterThan(0)
        assertThat(first.successes + first.failures).isEqualTo(first.originalArrivals)
        assertThat(first.services.keys).containsExactly("front", "back")
        assertThat(run(chain, replication = 0)).isEqualTo(first)
        assertThat(run(chain, replication = 1).arrivalTimesMs).isNotEqualTo(first.arrivalTimesMs)
    }

    @Test
    fun `a fault multiplies processing only while it is active`() {
        val chain =
            chain(faults = listOf(FaultSpan("front", fromMs = 0.0, toMs = 50.0, processingMultiplier = 3.0, failureProbability = null)))
                .copy(calls = emptyList(), services = listOf(ServiceNode("front", 2, 4, Distribution(DistributionShape.FIXED, 10.0), 0.0)))
        val plan = StreamPlan(PathStreams.keys(chain, 0))
        val model = Model("FaultWindow", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, chain, PathStreamSource(plan, chain.run.seed, 0))
        val driver = Driver(model, reliabilityModel, arrivalsMs = listOf(0.0, 60.0))
        model.numberOfReplications = 1
        model.lengthOfReplication = 200.0

        model.simulate()

        assertThat(driver.created.map { it.work.processCompletionTime }).containsExactly(30.0, 70.0)
    }

    private class Driver(
        model: Model,
        private val reliabilityModel: ReliabilityModel,
        private val arrivalsMs: List<Double>,
    ) : ProcessModel(model) {
        val created = mutableListOf<ReliabilityModel.ServiceInvocation>()

        override fun initialize() {
            created.clear()
            arrivalsMs.forEach { created += reliabilityModel.invoke(serviceId = "front", timeUntilActivation = it) }
        }
    }
}
