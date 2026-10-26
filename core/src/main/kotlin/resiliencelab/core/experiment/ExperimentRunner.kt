package resiliencelab.core.experiment

import kotlinx.coroutines.runBlocking
import ksl.controls.experiments.ConcurrentScenarioRunner
import ksl.controls.experiments.ExperimentRunParameters
import ksl.simulation.ExperimentRunParametersIfc
import ksl.simulation.Model
import ksl.simulation.ModelBuilderIfc
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.ExperimentDocument
import resiliencelab.core.scenario.ScenarioValidator
import resiliencelab.core.simulation.ExperimentExecutionException
import resiliencelab.core.simulation.ReliabilityModel
import kotlin.time.Duration.Companion.seconds
import ksl.controls.experiments.Scenario as KSLScenario

/**
 * Validates and executes all variants with KSL using their common replication and seed configuration.
 * Every replication must drain completely; missing, duplicate, or failed replications prevent a result from being returned.
 */
object ExperimentRunner {
    fun run(document: ExperimentDocument): ExperimentResult {
        ScenarioValidator.requireValid(document)
        val stores = document.variants.map { ReplicationResultStore(it.id) }
        val scenarios =
            document.variants.mapIndexed { index, variant ->
                KSLScenario(
                    modelBuilder = modelBuilder(document, index, stores[index]),
                    name = variant.id,
                    runParameters = runParameters(variant.id, index, document.execution),
                )
            }
        val runner =
            ConcurrentScenarioRunner(
                name = "resilience-lab-experiment",
                scenarioList = scenarios,
                kslDb = null,
            )
        runBlocking { runner.simulate() }

        val replications =
            scenarios.mapIndexed { index, scenario ->
                val simulationRun =
                    scenario.simulationRun
                        ?: throw ExperimentExecutionException("Variant '${document.variants[index].id}' did not execute")
                if (simulationRun.hasError) {
                    throw ExperimentExecutionException(
                        "Variant '${document.variants[index].id}' failed: ${simulationRun.runErrorMsg}",
                    )
                }
                stores[index].snapshot(document.execution.replications)
            }
        return ExperimentResult(
            schemaVersion = 1,
            applicationVersion = "0.1.0",
            kslVersion = "R1.8.1",
            variants =
                document.variants.mapIndexed { index, variant ->
                    val variantReplications = replications[index]
                    VariantResult(
                        id = variant.id,
                        label = variant.label,
                        sweepParameter = variant.sweepParameter,
                        sweepValue = variant.sweepValue,
                        replications = variantReplications,
                        aggregate = MetricsAggregator.aggregate(variantReplications),
                    )
                },
        )
    }

    private fun modelBuilder(
        document: ExperimentDocument,
        variantIndex: Int,
        store: ReplicationResultStore,
    ): ModelBuilderIfc =
        object : ModelBuilderIfc {
            override fun build(
                modelConfiguration: Map<String, String>?,
                experimentRunParameters: ExperimentRunParametersIfc?,
            ): Model {
                val variant = document.variants[variantIndex]
                val model = Model("resilience-lab", autoCSVReports = false)
                val reliabilityModel =
                    ReliabilityModel(
                        model = model,
                        scenario = variant.scenario,
                        execution = document.execution,
                        onReplicationCompleted = store::record,
                    )
                reliabilityModel.prepareWorkload()
                return model
            }
        }

    private fun runParameters(
        variantId: String,
        variantIndex: Int,
        execution: Execution,
    ): ExperimentRunParameters =
        ExperimentRunParameters(
            experimentName = variantId,
            experimentId = variantIndex + 1,
            numberOfReplications = execution.replications,
            numChunks = 1,
            runName = "Run1",
            startingRepId = 1,
            lengthOfReplication = Double.POSITIVE_INFINITY,
            lengthOfReplicationWarmUp = 0.0,
            replicationInitializationOption = true,
            maximumAllowedExecutionTimePerReplication = execution.maxRealTimeSeconds.seconds,
            resetStartStreamOption = false,
            advanceNextSubStreamOption = true,
            antitheticOption = false,
            numberOfStreamAdvancesPriorToRunning = 0,
            garbageCollectAfterReplicationFlag = false,
        )
}
