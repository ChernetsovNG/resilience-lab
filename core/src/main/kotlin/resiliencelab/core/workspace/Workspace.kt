package resiliencelab.core.workspace

import java.nio.channels.FileChannel
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import java.security.MessageDigest
import java.time.Duration
import kotlin.io.path.isDirectory
import kotlin.io.path.isRegularFile

/** Document text with its version — the SHA-256 of its UTF-8 bytes. */
data class VersionedDocument(
    val path: String,
    val text: String,
    val version: String,
)

class DocumentNotFoundException(
    path: String,
) : RuntimeException("Document '$path' does not exist")

class VersionConflictException(
    path: String,
    expected: String,
    actual: String?,
) : RuntimeException("Document '$path' has version ${actual ?: "none"}, not the expected $expected")

class InvalidDocumentPathException(
    path: String,
) : IllegalArgumentException("Path '$path' is not a relative path inside the workspace")

class DocumentExistsException(
    path: String,
) : RuntimeException("Document '$path' already exists")

/** Versions of document text. */
object DocumentVersion {
    fun of(text: String): String = of(text.toByteArray(Charsets.UTF_8))

    /** SHA-256 of the stored bytes, including compressed artifact parts. */
    fun of(bytes: ByteArray): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
}

/** Storage of workspace documents addressed by relative paths with `/` separators (ADR 0003). */
interface Workspace {
    /** Relative paths of `.json` documents outside hidden directories, sorted. */
    fun list(): List<String>

    /** Relative paths of all files under [directory], hidden ones included, sorted; empty when it does not exist. */
    fun listFiles(directory: String): List<String>

    fun read(path: String): VersionedDocument

    /** Reads a binary artifact with the same path confinement as document reads. */
    fun readBytes(path: String): ByteArray

    fun exists(path: String): Boolean

    /** Deletes a regular file if it exists; missing files are ignored. */
    fun delete(path: String)

    /**
     * Writes [text] and returns its version. When [expectedVersion] is set, the current version must match it;
     * otherwise [VersionConflictException] is thrown and nothing is written.
     */
    fun write(
        path: String,
        text: String,
        expectedVersion: String? = null,
    ): String

    /** Deletes [path] only when its current version equals [expectedVersion]. */
    fun delete(
        path: String,
        expectedVersion: String,
    )

    /**
     * Creates a new document without replacing an existing one. Concurrent attempts across workspace instances have
     * exactly one successful creator.
     */
    fun create(
        path: String,
        text: String,
    ): String

    /** Creates binary content without replacement; returns the SHA-256 of the stored bytes. */
    fun createBytes(
        path: String,
        bytes: ByteArray,
    ): String

    /** Returns changes after [since], or the current cursor and no changes when [since] is null. */
    fun changes(since: Long?): WorkspaceChangeBatch
}

/**
 * Workspace in a directory, usually a git repository. Paths may not leave the directory, also through symbolic links;
 * listings skip symbolic links. A root alias is pinned to its physical directory when this workspace is opened.
 *
 * All mutations coordinate through a JDK filesystem lock on the stable `.workspace.lock` inside that directory.
 * This workspace owns the lock metadata: public mutations cannot replace or remove it.
 * Cooperating instances and JVMs serialize version checks with replacement; the filesystem must support file locks.
 * Uncooperative external editors and hostile filesystem replacement are outside this coordination protocol.
 */
class FileWorkspace(
    root: Path,
    scanInterval: Duration = Duration.ofSeconds(1),
    historyLimit: Int = 1000,
) : Workspace,
    AutoCloseable {
    private val root: Path = root.toRealPath()
    private val lockFile: Path = this.root.resolve(".workspace.lock")
    private val journal = WorkspaceChangeJournal(this.root, scanInterval, historyLimit, mutationMonitor)

    override fun list(): List<String> =
        Files.walk(root).use { paths ->
            paths
                .filter { it.isRegularFile(NOFOLLOW_LINKS) && it.fileName.toString().endsWith(".json") }
                .map { root.relativize(it) }
                .filter { relative -> relative.none { it.toString().startsWith(".") } }
                .map { it.joinToString("/") }
                .sorted()
                .toList()
        }

    override fun listFiles(directory: String): List<String> {
        val start = resolve(directory)
        if (!start.isDirectory()) return emptyList()
        return Files.walk(start).use { paths ->
            paths
                .filter { it.isRegularFile(NOFOLLOW_LINKS) }
                .map { root.relativize(it).joinToString("/") }
                .sorted()
                .toList()
        }
    }

    override fun read(path: String): VersionedDocument {
        val file = resolve(path)
        if (!file.isRegularFile()) throw DocumentNotFoundException(path)
        val text = Files.readString(file)
        return VersionedDocument(path, text, DocumentVersion.of(text))
    }

    override fun readBytes(path: String): ByteArray {
        val file = resolve(path)
        if (!file.isRegularFile()) throw DocumentNotFoundException(path)
        return Files.readAllBytes(file)
    }

    override fun exists(path: String): Boolean = resolve(path).isRegularFile()

    override fun delete(path: String) =
        mutate(path, version = { null }) { file ->
            if (Files.exists(file, NOFOLLOW_LINKS) && !file.isRegularFile(NOFOLLOW_LINKS)) {
                throw InvalidDocumentPathException(path)
            }
            Files.deleteIfExists(file)
            Unit
        }

    override fun write(
        path: String,
        text: String,
        expectedVersion: String?,
    ): String =
        mutate(path, version = { it }) { file ->
            if (expectedVersion != null) {
                val current = if (file.isRegularFile()) DocumentVersion.of(Files.readString(file)) else null
                if (current != expectedVersion) throw VersionConflictException(path, expectedVersion, current)
            }
            store(file, text)
        }

    override fun create(
        path: String,
        text: String,
    ): String = createBytes(path, text.toByteArray(Charsets.UTF_8))

    override fun delete(
        path: String,
        expectedVersion: String,
    ) {
        mutate(path, version = { null }) { file ->
            if (!file.isRegularFile()) throw DocumentNotFoundException(path)
            val current = DocumentVersion.of(Files.readAllBytes(file))
            if (current != expectedVersion) throw VersionConflictException(path, expectedVersion, current)
            Files.delete(file)
        }
    }

    override fun createBytes(
        path: String,
        bytes: ByteArray,
    ): String =
        mutate(path, version = { it }) { file ->
            Files.createDirectories(file.parent)
            try {
                Files.write(file, bytes, CREATE_NEW, WRITE)
            } catch (_: FileAlreadyExistsException) {
                throw DocumentExistsException(path)
            }
            DocumentVersion.of(bytes)
        }

    override fun changes(since: Long?): WorkspaceChangeBatch = journal.changes(since)

    override fun close() = journal.close()

    private fun <T> mutate(
        path: String,
        version: (T) -> String?,
        action: (Path) -> T,
    ): T =
        synchronized(mutationMonitor) {
            FileChannel.open(lockFile, CREATE, WRITE, NOFOLLOW_LINKS).use { channel ->
                channel.lock().use {
                    val file = resolve(path)
                    if (file.startsWith(lockFile) || (Files.exists(file) && Files.isSameFile(file, lockFile))) {
                        throw InvalidDocumentPathException(path)
                    }
                    val result = action(file)
                    journal.record(path, version(result))
                    result
                }
            }
        }

    private fun store(
        file: Path,
        text: String,
    ): String {
        Files.createDirectories(file.parent)
        val temporary = Files.createTempFile(file.parent, ".write-", ".tmp")
        Files.writeString(temporary, text)
        Files.move(temporary, file, REPLACE_EXISTING, ATOMIC_MOVE)
        return DocumentVersion.of(text)
    }

    /**
     * Maps a workspace path to a file inside the root. The deepest existing component of the path must resolve inside
     * the real root, so a symbolic link cannot lead reads or writes outside the workspace.
     */
    private fun resolve(path: String): Path {
        if (path.isBlank() || path.startsWith("/") || path.contains('\\')) throw InvalidDocumentPathException(path)
        val file =
            try {
                root.resolve(path).normalize()
            } catch (exception: InvalidPathException) {
                throw InvalidDocumentPathException(path)
            }
        if (!file.startsWith(root) || file == root) throw InvalidDocumentPathException(path)
        var existing = file
        while (!Files.exists(existing, NOFOLLOW_LINKS)) existing = existing.parent
        val real = runCatching { existing.toRealPath() }.getOrNull()
        if (real == null || !real.startsWith(root)) throw InvalidDocumentPathException(path)
        return file
    }

    private companion object {
        // ponytail: one JVM monitor serializes all roots; scope monitors by root only if workspace throughput requires it.
        val mutationMonitor = Any()
    }
}
