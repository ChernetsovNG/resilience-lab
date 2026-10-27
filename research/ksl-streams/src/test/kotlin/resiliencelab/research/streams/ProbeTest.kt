package resiliencelab.research.streams

import org.assertj.core.api.Assertions.assertThat
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.nio.file.Path
import org.junit.jupiter.api.io.TempDir
import kotlin.random.Random
import kotlin.test.Test

class ProbeTest {
    private data class Tree(val id: String, val children: List<Tree> = emptyList())
    private val tree = Tree("system", listOf(
        Tree("frontend"),
        Tree("east", listOf(Tree("api"), Tree("storage", listOf(Tree("db"))))),
        Tree("west", listOf(Tree("api"), Tree("db"))),
    ))
    private fun depthFirst(node: Tree, parents: List<String> = emptyList()): List<ProbeBlock> {
        val path = parents + node.id
        return if (node.children.isEmpty()) listOf(ProbeBlock(path))
        else node.children.flatMap { depthFirst(it, path) }
    }
    private fun breadthFirst(): List<ProbeBlock> {
        val queue = ArrayDeque(listOf(tree to emptyList<String>()))
        val result = mutableListOf<ProbeBlock>()
        while (queue.isNotEmpty()) {
            val (node, parents) = queue.removeFirst()
            val path = parents + node.id
            if (node.children.isEmpty()) result.add(ProbeBlock(path))
            else node.children.forEach { queue.addLast(it to path) }
        }
        return result
    }
    @TempDir
    lateinit var output: Path
    private fun run(plan: StreamPlan, replication: Long, blocks: List<ProbeBlock>) =
        runProbe(plan, 42, replication, blocks, 64, Files.createTempDirectory(output, "model-"))

    @Test
    fun `real KSL results survive DFS BFS block permutation and 1 2 4 8 workers`() {
        val blocks = depthFirst(tree)
        assertThat(breadthFirst().map { it.path }).isNotEqualTo(blocks.map { it.path })
        val plan = StreamPlan((0L..7L).flatMap { keys(42, it, blocks) })
        fun batch(workers: Int, bfs: Boolean): Map<Long, ProbeResult> =
            Executors.newFixedThreadPool(workers).use { executor ->
                val submission = if (bfs) (0L..7L).reversed() else (0L..7L).toList()
                val tasks = submission.map { replication -> Callable {
                    val order = if (bfs) breadthFirst().shuffled(Random(replication.toInt() + 100)) else blocks
                    if (bfs) assertThat(order.map { it.path }).isNotEqualTo(blocks.map { it.path })
                    replication to run(plan, replication, order)
                } }
                executor.invokeAll(tasks).associate { it.get() }
            }
        val baseline = batch(1, false)
        baseline.values.forEach { result ->
            assertThat(result.completions).hasSize(5)
            assertThat(result.completions.values).allSatisfy { assertThat(it).hasSize(64) }
            assertThat(result.samples).hasSize(15)
        }
        for (workers in listOf(1, 2, 4, 8)) assertThat(batch(workers, true)).isEqualTo(baseline)
        assertThat(baseline.values.map { it.completions }.toSet()).hasSize(8)
        // Model.simulate must not reset every externally addressed source to the native origin.
        val reference = plan.open(keys(42, 0, blocks))
        val processing = StreamKey(42, 0, blocks.first().path, "processing")
        assertThat(baseline.getValue(0).samples.getValue(processing))
            .isEqualTo(List(64) { reference.getValue(processing).rExponential(1.0).toBits() })
    }

    @Test
    fun `adding unrelated block preserves outcomes but changed service parameters only preserve draws`() {
        val blocks = depthFirst(tree)
        val extra = ProbeBlock(listOf("system", "extra"))
        val all = blocks + extra
        val plan = StreamPlan(keys(42, 0, all))
        val baseline = run(plan, 0, blocks)
        val inserted = run(plan, 0, all.reversed())
        assertThat(baseline.completions).hasSize(5)
        assertThat(inserted.completions.filterKeys { it != extra.path }).isEqualTo(baseline.completions)
        assertThat(inserted.samples.filterKeys { it.path != extra.path }).isEqualTo(baseline.samples)
        assertThat(inserted.successes.filterKeys { it != extra.path }).isEqualTo(baseline.successes)
        val candidate = run(plan, 0, blocks.map { it.copy(meanService = 1.4) })
        assertThat(candidate.samples).isEqualTo(baseline.samples)
        assertThat(candidate.completions).isNotEqualTo(baseline.completions)
    }
}
