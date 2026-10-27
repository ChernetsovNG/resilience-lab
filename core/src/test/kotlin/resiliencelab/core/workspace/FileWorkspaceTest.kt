package resiliencelab.core.workspace

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.WRITE
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS
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
    fun `lists and reads through a pinned symbolic link root`(
        @TempDir aliases: Path,
    ) {
        Files.writeString(root.resolve("a.model.json"), "original\n")
        Files.createSymbolicLink(root.resolve("internal.model.json"), root.resolve("a.model.json"))
        val alias = Files.createSymbolicLink(aliases.resolve("workspace"), root)
        val aliasedWorkspace = FileWorkspace(alias)

        assertThat(aliasedWorkspace.list()).containsExactly("a.model.json")
        assertThat(aliasedWorkspace.read("a.model.json").text).isEqualTo("original\n")
        Files.delete(alias)
        Files.createSymbolicLink(alias, Files.createDirectory(aliases.resolve("other")))
        aliasedWorkspace.write("b.model.json", "pinned\n")
        assertThat(workspace.read("b.model.json").text).isEqualTo("pinned\n")
        assertThat(aliasedWorkspace.list()).containsExactly("a.model.json", "b.model.json")
    }

    @Test
    fun `separate instances accept exactly one update from a shared version`() {
        val start = CountDownLatch(1)
        val ready = CountDownLatch(2)
        val version = workspace.write("shared.model.json", "initial".repeat(100_000))
        val candidates = listOf("first\n", "second\n")
        val pool = Executors.newFixedThreadPool(2)
        try {
            val attempts =
                listOf(workspace, FileWorkspace(root)).mapIndexed { index, instance ->
                    pool.submit(
                        Callable {
                            ready.countDown()
                            check(start.await(10, SECONDS))
                            runCatching { instance.write("shared.model.json", candidates[index], version) }
                        },
                    )
                }
            assertThat(ready.await(10, SECONDS)).isTrue()
            start.countDown()
            val results = attempts.map { it.get(10, SECONDS) }

            assertThat(results.count { it.isSuccess }).isEqualTo(1)
            assertThat(results.single { it.isFailure }.exceptionOrNull()).isInstanceOf(VersionConflictException::class.java)
            val winner = results.indexOfFirst { it.isSuccess }
            assertThat(workspace.read("shared.model.json").text).isEqualTo(candidates[winner])
            assertThat(workspace.read("shared.model.json").version).isEqualTo(results[winner].getOrThrow())
            assertThat(Files.readAllBytes(root.resolve("shared.model.json"))).isEqualTo(candidates[winner].toByteArray())
        } finally {
            start.countDown()
            pool.shutdownNow()
            assertThat(pool.awaitTermination(10, SECONDS)).isTrue()
        }
    }

    @Test
    fun `separate JVM writers coordinate on the lock and retain exactly one winner`() {
        val version = workspace.write("shared.model.json", "initial\n")
        val candidates = listOf("first\n", "second\n")
        val processes = mutableListOf<Process>()
        val pool = Executors.newFixedThreadPool(2)
        try {
            FileChannel.open(root.resolve(".workspace.lock"), CREATE, WRITE).use { channel ->
                val heldLock = channel.lock()
                try {
                    candidates.forEach { processes += writerProcess(version, it) }
                    val readers = processes.map { it.inputStream.bufferedReader() }
                    readers.forEach { reader ->
                        assertThat(pool.submit(Callable { reader.readLine() }).get(15, SECONDS)).isEqualTo("READY")
                    }
                    processes.forEach { process ->
                        process.outputStream.bufferedWriter().apply {
                            write("GO\n")
                            flush()
                        }
                    }
                    // Each child acknowledges an actual FileChannel.lock wait, rather than relying on a sleep.
                    readers.forEach { reader ->
                        assertThat(pool.submit(Callable { reader.readLine() }).get(15, SECONDS)).isEqualTo("BLOCKED")
                    }
                    heldLock.release()
                    val results = readers.map { reader -> pool.submit(Callable { reader.readLine() }).get(15, SECONDS) }
                    processes.forEach { process ->
                        assertThat(process.waitFor(15, SECONDS)).isTrue()
                        assertThat(process.exitValue()).isZero()
                    }

                    assertThat(results.count { it.startsWith("SUCCESS:") }).isEqualTo(1)
                    assertThat(results.count { it == "CONFLICT" }).isEqualTo(1)
                    val winner = results.indexOfFirst { it.startsWith("SUCCESS:") }
                    assertThat(workspace.read("shared.model.json").text).isEqualTo(candidates[winner])
                    assertThat(workspace.read("shared.model.json").version).isEqualTo(results[winner].removePrefix("SUCCESS:"))
                    assertThat(Files.readAllBytes(root.resolve("shared.model.json"))).isEqualTo(candidates[winner].toByteArray())
                } finally {
                    if (heldLock.isValid) heldLock.release()
                }
            }
        } finally {
            processes.forEach { process -> if (process.isAlive) process.destroyForcibly() }
            val stopped = processes.map { it.waitFor(10, SECONDS) }
            processes.forEach { process ->
                process.outputStream.close()
                process.inputStream.close()
                process.errorStream.close()
            }
            pool.shutdownNow()
            val poolStopped = pool.awaitTermination(10, SECONDS)
            assertThat(stopped).containsOnly(true)
            assertThat(poolStopped).isTrue()
        }
    }

    private fun writerProcess(
        version: String,
        text: String,
    ): Process {
        val classpath =
            listOf(WorkspaceWriterProcess::class.java, FileWorkspace::class.java, Unit::class.java)
                .map {
                    File(
                        it.protectionDomain.codeSource.location
                            .toURI(),
                    ).path
                }.distinct()
                .joinToString(File.pathSeparator)
        return ProcessBuilder(
            Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp",
            classpath,
            WorkspaceWriterProcess::class.java.name,
            root.toString(),
            version,
            text,
        ).redirectError(ProcessBuilder.Redirect.INHERIT).start()
    }

    @Test
    fun `keeps lock metadata stable and rejects public mutation aliases`() {
        workspace.write("a.model.json", "original\n")
        val lock = root.resolve(".workspace.lock")
        val identity = Files.createLink(root.resolve(".lock-identity"), lock)
        Files.createSymbolicLink(root.resolve("lock-alias"), lock)
        Files.createSymbolicLink(root.resolve("root-alias"), root)
        listOf(
            ".workspace.lock",
            "./.workspace.lock",
            "nested/../.workspace.lock",
            "root-alias/.workspace.lock",
            "lock-alias",
            ".lock-identity",
        ).forEach { path ->
            assertThatThrownBy { workspace.write(path, "corrupt") }
                .describedAs(path)
                .isInstanceOf(InvalidDocumentPathException::class.java)
            assertThatThrownBy { workspace.create(path, "corrupt") }
                .describedAs(path)
                .isInstanceOf(InvalidDocumentPathException::class.java)
        }
        workspace.write("a.model.json", "updated\n")
        workspace.create("b.model.json", "new\n")

        assertThat(Files.isSameFile(lock, identity)).isTrue()
        assertThat(Files.size(lock)).isZero()
        assertThat(workspace.list()).containsExactly("a.model.json", "b.model.json")
    }

    @Test
    fun `rejects documents that are not UTF-8`() {
        Files.write(root.resolve("broken.model.json"), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))

        assertThatThrownBy { workspace.read("broken.model.json") }.isInstanceOf(IOException::class.java)
    }
}
