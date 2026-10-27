package resiliencelab.research.ksl

import ksl.animation.AnimationCapture
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.data.Offset.offset
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.io.path.readText
import kotlin.test.Test

class CapabilityModelTest {
    private fun deterministic() = Workload(
        blocks = 5, requests = 1, randomDurations = false, traceEvery = 1, series = true,
        windows = 10, observationEnd = 10.0, capacity = 1,
        pre = 1.0, db = 4.0, childA = 1.0, childB = 1.0, childDb = 3.0, post = 1.0, timeout = 2.0,
    )

    private fun run(workload: Workload, replication: Int = 1): CapabilityModel {
        val (model, graph) = createModel(workload, replication, Files.createTempDirectory("ksl-proof-"))
        try { model.simulate(); graph.verifyDrained(); return graph } finally { model.outputDirectory.close() }
    }

    @Test fun `phase allocations differ while timed out downstream drains`() {
        val blocking = run(deterministic().copy(blocking = true))
        val nonblocking = run(deterministic())
        for (graph in listOf(blocking, nonblocking)) {
            assertThat(graph.clientEnd).containsExactly(8.0)
            assertThat(graph.childEnd).containsExactly(6.0, 9.0)
            assertThat(graph.timedOut).containsExactly(true)
            assertThat(graph.lateChildren).isEqualTo(1)
            assertThat(graph.joinResumptions).isEqualTo(1)
            assertThat(graph.trace.filter { it.node == graph.resources[1].name && it.action != "queue" }.map { it.time }).containsExactly(1.0, 5.0)
        }
        fun workerArea(graph: CapabilityModel) = graph.seriesRows().filter { it.responseName == graph.resources[0].numBusyUnits.name }.sumOf { it.value!! * it.length }
        assertThat(workerArea(blocking)).isCloseTo(8.0, offset(1e-12))
        assertThat(workerArea(nonblocking)).isCloseTo(2.0, offset(1e-12))
        assertThat(nonblocking.seriesRows()).hasSize(100)
    }

    @Test fun `native join waits for both activated children`() {
        val graph = run(deterministic().copy(timeout = null))
        assertThat(graph.clientEnd).containsExactly(10.0)
        assertThat(graph.timedOut).containsExactly(false)
    }

    @Test fun `completion at deadline wins and resumes caller once`() {
        val graph = run(deterministic().copy(timeout = 4.0, childA = 4.0))
        assertThat(graph.clientEnd).containsExactly(10.0)
        assertThat(graph.timedOut).containsExactly(false)
        assertThat(graph.joinResumptions).isEqualTo(1)
    }

    @Test fun `zero timeout still drains accepted children waiting in resource queues`() {
        val graph = run(deterministic().copy(
            requests = 3, arrivalInterval = 0.0, observationEnd = 15.0,
            pre = 0.0, db = 0.0, post = 0.0, childA = 4.0, childB = 0.0, childDb = 4.0, timeout = 0.0,
        ))
        assertThat(graph.clientEnd).containsExactly(0.0, 0.0, 0.0)
        assertThat(graph.childEnd.max()).isEqualTo(12.0)
        assertThat(graph.lateChildren).isEqualTo(6)
        assertThat(graph.timedOut).containsExactly(true, true, true)
    }

    @Test fun `request sampling does not alias round robin subsystem assignment`() {
        val graph = run(Workload(blocks = 500, requests = 10_000, traceEvery = 100))
        val sampledSubsystems = graph.trace.filter { it.action == "arrival" }.map { it.node }.distinct()
        assertThat(sampledSubsystems.size).isGreaterThan(20)
    }

    @Test fun `nonblocking slot can serve another request during IO`() {
        val base = deterministic().copy(requests = 2, arrivalInterval = 0.0, observationEnd = 20.0)
        val blocking = run(base.copy(blocking = true))
        val nonblocking = run(base)
        assertThat(blocking.clientEnd.max()).isEqualTo(16.0)
        assertThat(nonblocking.clientEnd.max()).isEqualTo(12.0)
    }

    @Test fun `instrumentation does not change outcomes or draw simulation randomness`() {
        val base = Workload(blocks = 50, requests = 500)
        val baseline = run(base)
        for (workload in listOf(base.copy(series = true), base.copy(traceEvery = 10), base.copy(series = true, traceEvery = 10))) {
            assertThat(run(workload).semanticHash()).isEqualTo(baseline.semanticHash())
        }
    }

    @Test fun `one two four eight workers preserve every replication row and trace`() {
        val workload = Workload(blocks = 50, requests = 500, series = true, traceEvery = 10)
        fun batch(workers: Int): List<Triple<String, Any, Any>> = Executors.newFixedThreadPool(workers).use { pool ->
            pool.invokeAll((1..8).map { id -> Callable {
                val graph = run(workload, id)
                Triple(graph.semanticHash(), graph.seriesRows(), graph.trace)
            } }).map { it.get() }
        }
        val expected = batch(1)
        assertThat(expected.map { it.first }.distinct()).hasSize(8)
        for (workers in listOf(1, 2, 4, 8)) assertThat(batch(workers)).isEqualTo(expected)
    }

    @Test fun `native animation capture writes resource and process events`() {
        val directory = Files.createTempDirectory("ksl-capture-proof-")
        val (model, graph) = createModel(deterministic(), 1, directory)
        val trace = directory.resolve("native.jsonl")
        try {
            AnimationCapture.toFile(model, trace).use { model.simulate() }
            graph.verifyDrained()
            assertThat(trace.readText()).contains(graph.resources[0].name, graph.resources[4].name, "\"event\":\"ProcessActivated\"", "\"event\":\"SeizeAllocated\"", "\"event\":\"Released\"")
        } finally { model.outputDirectory.close() }
    }
}
