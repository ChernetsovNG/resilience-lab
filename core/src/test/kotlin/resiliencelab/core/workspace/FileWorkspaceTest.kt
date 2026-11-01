package resiliencelab.core.workspace

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.BasicFileAttributes
import java.time.Duration
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
    fun `deletes a regular file idempotently within the workspace`() {
        workspace.write("a.model.json", "{}\n")

        workspace.delete("a.model.json")
        workspace.delete("a.model.json")

        assertThat(workspace.exists("a.model.json")).isFalse()
        assertThatThrownBy { workspace.delete("../outside") }.isInstanceOf(InvalidDocumentPathException::class.java)
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
    fun `deletes a document at the expected version`() {
        val version = workspace.write("a.model.json", "1\n")

        workspace.delete("a.model.json", expectedVersion = version)

        assertThat(workspace.exists("a.model.json")).isFalse()
        assertThat(root).isDirectory()
    }

    @Test
    fun `deletes the empty model directory after its last document`() {
        val model = workspace.write("models/example/example.model.json", "model\n")
        val layout = workspace.write("models/example/example.layout.json", "layout\n")
        val experiment = workspace.write("models/example/example.experiment.json", "experiment\n")
        val directory = root.resolve("models/example")

        workspace.delete("models/example/example.experiment.json", expectedVersion = experiment)
        workspace.delete("models/example/example.layout.json", expectedVersion = layout)
        assertThat(directory).isDirectory()

        workspace.delete("models/example/example.model.json", expectedVersion = model)

        assertThat(directory).doesNotExist()
        assertThat(root.resolve("models")).isDirectory()
        assertThat(root).isDirectory()
    }

    @Test
    fun `keeps a model directory containing unrelated files`() {
        val version = workspace.write("example/example.model.json", "model\n")
        val unrelated = root.resolve("example/.gitkeep")
        Files.writeString(unrelated, "keep\n")

        workspace.delete("example/example.model.json", expectedVersion = version)

        assertThat(root.resolve("example")).isDirectory()
        assertThat(unrelated).hasContent("keep\n")
    }

    @Test
    fun `keeps directories reached through symbolic link aliases`() {
        val direct = workspace.write("models/direct/example.model.json", "direct\n")
        val nested = workspace.write("models/nested/example.model.json", "nested\n")
        Files.createSymbolicLink(root.resolve("direct-alias"), root.resolve("models/direct"))
        Files.createSymbolicLink(root.resolve("models-alias"), root.resolve("models"))

        workspace.delete("direct-alias/example.model.json", expectedVersion = direct)
        workspace.delete("models-alias/nested/example.model.json", expectedVersion = nested)

        assertThat(root.resolve("direct-alias")).isSymbolicLink()
        assertThat(root.resolve("models-alias")).isSymbolicLink()
        assertThat(root.resolve("models/direct")).isEmptyDirectory()
        assertThat(root.resolve("models/nested")).isEmptyDirectory()
    }

    @Test
    fun `rejects deletion against a stale version`() {
        val version = workspace.write("a.model.json", "1\n")
        workspace.write("a.model.json", "2\n", expectedVersion = version)

        assertThatThrownBy { workspace.delete("a.model.json", expectedVersion = version) }
            .isInstanceOf(VersionConflictException::class.java)
        assertThat(workspace.read("a.model.json").text).isEqualTo("2\n")
    }

    @Test
    fun `rejects deletion of a missing document`() {
        assertThatThrownBy { workspace.delete("missing.model.json", expectedVersion = "stale") }
            .isInstanceOf(DocumentNotFoundException::class.java)
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
        createSymbolicLink(root.resolve("external"), outside)

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
        createSymbolicLink(root.resolve("internal.model.json"), root.resolve("a.model.json"))
        val alias = createSymbolicLink(aliases.resolve("workspace"), root)
        val aliasedWorkspace = FileWorkspace(alias)

        assertThat(aliasedWorkspace.list()).containsExactly("a.model.json")
        assertThat(aliasedWorkspace.read("a.model.json").text).isEqualTo("original\n")
        Files.delete(alias)
        createSymbolicLink(alias, Files.createDirectory(aliases.resolve("other")))
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
            listOf(
                WorkspaceWriterProcess::class.java,
                FileWorkspace::class.java,
                Unit::class.java,
                kotlinx.serialization.KSerializer::class.java,
            ).map {
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
        createSymbolicLink(root.resolve("lock-alias"), lock)
        createSymbolicLink(root.resolve("root-alias"), root)
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

    @Test
    fun `lists every file under a directory, hidden ones included`() {
        workspace.write(".results/e/run-1/manifest.json", "{}\n")
        workspace.write(".results/e/run-1/summary.json", "{}\n")
        workspace.write("a.model.json", "{}\n")

        assertThat(workspace.listFiles(".results"))
            .containsExactly(".results/e/run-1/manifest.json", ".results/e/run-1/summary.json")
        assertThat(workspace.listFiles("missing")).isEmpty()
        assertThatThrownBy { workspace.listFiles("../outside") }.isInstanceOf(InvalidDocumentPathException::class.java)
    }

    @Test
    fun `journals API mutations with cursors from an empty baseline`() {
        Files.writeString(root.resolve("existing.model.json"), "existing\n")
        FileWorkspace(root, scanInterval = Duration.ofSeconds(30)).use { files ->
            val baseline = files.changes(null)
            assertThat(baseline.cursor.sequence).isZero()
            assertThat(baseline.reset).isFalse()
            assertThat(baseline.changes).isEmpty()

            val created = files.create("a.model.json", "1\n")
            val updated = files.write("a.model.json", "2\n", expectedVersion = created)
            files.delete("a.model.json", expectedVersion = updated)

            val batch = files.changes(baseline.cursor)
            assertThat(batch.cursor.sequence).isEqualTo(3)
            assertThat(batch.reset).isFalse()
            assertThat(batch.changes).containsExactly(
                WorkspaceChange("a.model.json", DocumentKind.MODEL, created),
                WorkspaceChange("a.model.json", DocumentKind.MODEL, updated),
                WorkspaceChange("a.model.json", DocumentKind.MODEL, null),
            )
            assertThat(files.changes(batch.cursor).changes).isEmpty()
            val latest = files.changes(null)
            assertThat(latest.cursor).isEqualTo(batch.cursor)
            assertThat(latest.changes).isEmpty()
        }
    }

    @Test
    fun `journals canonical paths for normalized API mutations`() {
        FileWorkspace(root, scanInterval = Duration.ofSeconds(30)).use { files ->
            val baseline = files.changes(null).cursor
            val created = files.create("nested/../a.model.json", "1\n")
            val updated = files.write("nested/../a.model.json", "2\n", expectedVersion = created)

            files.delete("nested/../a.model.json", expectedVersion = updated)

            val batch = files.changes(baseline)
            assertThat(batch.cursor.sequence).isEqualTo(3)
            assertThat(batch.changes.map { it.path }).containsExactly("a.model.json", "a.model.json", "a.model.json")
            assertThat(batch.changes.map { it.version }).containsExactly(created, updated, null)
        }
    }

    @Test
    fun `resets a cursor evicted from bounded history or coming from the future`() {
        FileWorkspace(root, scanInterval = Duration.ofSeconds(30), historyLimit = 2).use { files ->
            val baseline = files.changes(null).cursor
            repeat(3) { files.create("$it.model.json", "$it\n") }

            val stale = files.changes(baseline)
            assertThat(stale.cursor.sequence).isEqualTo(3)
            assertThat(stale.reset).isTrue()
            assertThat(stale.changes).isEmpty()
            assertThat(files.changes(stale.cursor).reset).isFalse()
            val future = files.changes(stale.cursor.copy(sequence = 4))
            assertThat(future.reset).isTrue()
            assertThat(future.cursor.sequence).isEqualTo(3)
            assertThat(future.changes).isEmpty()
        }
    }

    @Test
    fun `resets cursors from a previous journal even after its sequence catches up`() {
        Files.writeString(root.resolve("a.model.json"), "initial\n")
        val previous = FileWorkspace(root, scanInterval = Duration.ofSeconds(30))
        val initial = previous.changes(null).cursor
        previous.write("a.model.json", "before restart\n")
        val caughtUp = previous.changes(null).cursor
        previous.close()
        Files.writeString(root.resolve("a.model.json"), "offline change\n")

        FileWorkspace(root, scanInterval = Duration.ofSeconds(30)).use { current ->
            val restarted = current.changes(initial)
            assertThat(restarted.reset).isTrue()
            assertThat(restarted.cursor.generation).isNotEqualTo(initial.generation)
            assertThat(restarted.changes).isEmpty()

            Files.writeString(root.resolve("b.model.json"), "new process\n")
            val next = current.changes(restarted.cursor)
            assertThat(next.reset).isFalse()
            val caughtUpReset = current.changes(caughtUp)
            assertThat(caughtUpReset.reset).isTrue()
            assertThat(caughtUpReset.changes).isEmpty()
        }
    }

    @Test
    fun `keeps non-documents hidden directories and symbolic links out of the journal`(
        @TempDir outside: Path,
    ) {
        FileWorkspace(root, scanInterval = Duration.ofSeconds(30)).use { files ->
            val baseline = files.changes(null).cursor

            files.create("notes.json", "{}\n")
            files.create(".hidden/a.model.json", "{}\n")
            files.create(".results/a.model.json", "{}\n")
            Files.writeString(root.resolve("notes.model.txt"), "not a document")
            val external = Files.writeString(outside.resolve("outside.model.json"), "outside\n")
            Files.createSymbolicLink(root.resolve("alias.model.json"), external)

            val batch = files.changes(baseline)
            assertThat(batch.cursor).isEqualTo(baseline)
            assertThat(batch.reset).isFalse()
            assertThat(batch.changes).isEmpty()
        }
    }

    @Test
    fun `visible workspace walks do not visit hidden directory contents`() {
        val visible = Files.createDirectories(root.resolve("visible/nested"))
        Files.writeString(visible.resolve("doc.model.json"), "{}\n")
        val results = Files.createDirectories(root.resolve(".results/deep"))
        Files.writeString(results.resolve("part.json"), "{}\n")
        val visited = mutableListOf<String>()

        walkVisibleWorkspace(
            root,
            object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(
                    dir: Path,
                    attrs: BasicFileAttributes,
                ): FileVisitResult {
                    visited += root.relativize(dir).joinToString("/")
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(
                    file: Path,
                    attrs: BasicFileAttributes,
                ): FileVisitResult {
                    visited += root.relativize(file).joinToString("/")
                    return FileVisitResult.CONTINUE
                }
            },
        )

        assertThat(visited).contains("visible", "visible/nested", "visible/nested/doc.model.json")
        assertThat(visited).noneMatch { it.startsWith(".results") }
    }

    @Test
    fun `defers the initial journal scan until changes are requested`() {
        val missing = root.resolve("missing")
        WorkspaceChangeJournal(missing, Duration.ofSeconds(30), 100, Any()).close()
        val journal = WorkspaceChangeJournal(missing, Duration.ofSeconds(30), 100, Any())

        assertThatThrownBy { journal.changes(null) }.isInstanceOf(IOException::class.java)
        journal.close()
    }

    @Test
    fun `propagates scan failures instead of returning a healthy stale batch`() {
        val scanRoot = Files.createDirectory(root.resolve("scan-root"))
        val files = FileWorkspace(scanRoot, scanInterval = Duration.ofSeconds(30))
        val baseline = files.changes(null).cursor
        Files.delete(scanRoot)

        assertThatThrownBy { files.changes(baseline) }.isInstanceOf(IOException::class.java)
        files.close()
    }

    @Test
    fun `falls back to scanning when the watch service is unavailable`() {
        WorkspaceChangeJournal(root, Duration.ofMillis(25), 100, Any()) {
            throw IOException("WatchService unavailable")
        }.use { journal ->
            val baseline = journal.changes(null).cursor
            Files.writeString(root.resolve("fallback.model.json"), "external\n")
            val deadline = System.currentTimeMillis() + 5_000
            var found = false
            while (System.currentTimeMillis() < deadline && !found) {
                found =
                    journal.changes(baseline).changes.any {
                        it.path == "fallback.model.json" && it.version == DocumentVersion.of("external\n")
                    }
                if (!found) Thread.sleep(25)
            }

            assertThat(found).isTrue()
        }
    }

    @Test
    fun `observes external creation modification and deletion within five seconds`() {
        FileWorkspace(root, scanInterval = Duration.ofMillis(25)).use { files ->
            val path = "nested/external.layout.json"
            val file = root.resolve(path)
            Files.createDirectories(file.parent)
            var cursor = files.changes(null).cursor

            Files.writeString(file, "one\n")
            val created = awaitChange(files, cursor, path, DocumentKind.LAYOUT, DocumentVersion.of("one\n"))
            cursor = created.cursor

            Files.writeString(file, "two\n")
            val updated = awaitChange(files, cursor, path, DocumentKind.LAYOUT, DocumentVersion.of("two\n"))
            cursor = updated.cursor

            Files.delete(file)
            awaitChange(files, cursor, path, DocumentKind.LAYOUT, null)
        }
    }

    private fun awaitChange(
        workspace: FileWorkspace,
        since: WorkspaceCursor,
        path: String,
        kind: DocumentKind,
        version: String?,
    ): WorkspaceChangeBatch {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            val batch = workspace.changes(since)
            val match = batch.changes.firstOrNull { it.path == path && it.version == version }
            if (match != null) {
                assertThat(match.kind).isEqualTo(kind)
                return batch
            }
            Thread.sleep(25)
        }
        throw AssertionError("Change '$path' at version '$version' was not observed within five seconds")
    }
}
