package resiliencelab.core.workspace

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.test.Test

class FileWorkspaceTest {
    @TempDir
    lateinit var root: Path

    private val workspace by lazy { FileWorkspace(root) }

    @Test
    fun `writes, reads and versions documents`() {
        val version = workspace.write("models/a.model.json", "{}\n")

        val document = workspace.read("models/a.model.json")

        assertThat(document.text).isEqualTo("{}\n")
        assertThat(document.version).isEqualTo(version).isEqualTo(DocumentVersion.of("{}\n"))
        assertThat(workspace.exists("models/a.model.json")).isTrue()
        assertThat(workspace.exists("models/missing.model.json")).isFalse()
    }

    @Test
    fun `rejects writes against a stale version`() {
        val first = workspace.write("a.model.json", "1\n")
        workspace.write("a.model.json", "2\n", expectedVersion = first)

        assertThatThrownBy { workspace.write("a.model.json", "3\n", expectedVersion = first) }
            .isInstanceOf(VersionConflictException::class.java)
        assertThatThrownBy { workspace.write("new.model.json", "x\n", expectedVersion = first) }
            .isInstanceOf(VersionConflictException::class.java)
    }

    @Test
    fun `lists json documents outside hidden directories`() {
        workspace.write("b.experiment.json", "{}\n")
        workspace.write("a/x.model.json", "{}\n")
        workspace.write(".results/run/summary.json", "{}\n")
        Files.writeString(root.resolve("notes.txt"), "x")

        assertThat(workspace.list()).containsExactly("a/x.model.json", "b.experiment.json")
    }

    @Test
    fun `rejects paths that leave the workspace and missing documents`() {
        listOf("../x.json", "/abs.json", "a/../../x.json", "", "a\\b.json", "\u0000.layout.json").forEach { path ->
            assertThatThrownBy { workspace.read(path) }.describedAs(path).isInstanceOf(InvalidDocumentPathException::class.java)
        }
        assertThatThrownBy { workspace.read("missing.json") }.isInstanceOf(DocumentNotFoundException::class.java)
    }

    @Test
    fun `rejects paths that escape through symbolic links`(
        @TempDir outside: Path,
    ) {
        Files.writeString(outside.resolve("outside.layout.json"), "{}\n")
        Files.createSymbolicLink(root.resolve("external"), outside)

        assertThatThrownBy { workspace.read("external/outside.layout.json") }.isInstanceOf(InvalidDocumentPathException::class.java)
        assertThatThrownBy { workspace.write("external/outside.layout.json", "x\n") }.isInstanceOf(InvalidDocumentPathException::class.java)
        assertThatThrownBy { workspace.create("external/new.layout.json", "x\n") }.isInstanceOf(InvalidDocumentPathException::class.java)
        assertThat(Files.readString(outside.resolve("outside.layout.json"))).isEqualTo("{}\n")
        assertThat(workspace.list()).isEmpty()
    }

    @Test
    fun `creates a document once even under concurrent requests`() {
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val attempts =
            (1..2).map { n ->
                pool.submit(
                    Callable {
                        start.await()
                        runCatching { workspace.create("race.layout.json", "$n\n") }
                    },
                )
            }
        start.countDown()
        val results = attempts.map { it.get() }
        pool.shutdown()

        assertThat(results.count { it.isSuccess }).isEqualTo(1)
        assertThat(results.single { it.isFailure }.exceptionOrNull()).isInstanceOf(DocumentExistsException::class.java)
        assertThat(workspace.read("race.layout.json").version).isEqualTo(results.single { it.isSuccess }.getOrThrow())
    }

    @Test
    fun `separate workspace instances atomically create a document once`() {
        val otherWorkspace = FileWorkspace(root)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val attempts =
            listOf(workspace, otherWorkspace).mapIndexed { index, instance ->
                pool.submit(
                    Callable {
                        start.await()
                        runCatching { instance.create("shared.layout.json", "$index\n") }
                    },
                )
            }
        start.countDown()
        val results = attempts.map { it.get() }
        pool.shutdown()

        assertThat(results.count { it.isSuccess }).isEqualTo(1)
        assertThat(results.single { it.isFailure }.exceptionOrNull()).isInstanceOf(DocumentExistsException::class.java)
        val winner = results.single { it.isSuccess }.getOrThrow()
        assertThat(workspace.read("shared.layout.json").version).isEqualTo(winner)
    }

    @Test
    fun `rejects documents that are not UTF-8`() {
        Files.write(root.resolve("broken.model.json"), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))

        assertThatThrownBy { workspace.read("broken.model.json") }.isInstanceOf(IOException::class.java)
    }
}
