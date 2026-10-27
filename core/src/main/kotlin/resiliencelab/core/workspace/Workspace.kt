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
    fun of(text: String): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}

/** Storage of workspace documents addressed by relative paths with `/` separators (ADR 0003). */
interface Workspace {
    /** Relative paths of `.json` documents outside hidden directories, sorted. */
    fun list(): List<String>

    /** Relative paths of all files under [directory], hidden ones included, sorted; empty when it does not exist. */
    fun listFiles(directory: String): List<String>

    fun read(path: String): VersionedDocument

    fun exists(path: String): Boolean

    /**
     * Writes [text] and returns its version. When [expectedVersion] is set, the current version must match it;
     * otherwise [VersionConflictException] is thrown and nothing is written.
     */
    fun write(
        path: String,
        text: String,
        expectedVersion: String? = null,
    ): String

    /**
     * Creates a new document without replacing an existing one. Concurrent attempts across workspace instances have
     * exactly one successful creator.
     */
    fun create(
        path: String,
        text: String,
    ): String
}

/**
 * Workspace in a directory, usually a git repository. Paths may not leave the directory, also through symbolic links;
 * listings skip symbolic links. A root alias is pinned to its physical directory when this workspace is opened.
 *
 * All mutations coordinate through a JDK filesystem lock on the stable `.workspace.lock` inside that directory.
 * This workspace owns the lock metadata: public writes/creates cannot replace it, and normal operations never remove it.
 * Cooperating instances and JVMs serialize version checks with replacement; the filesystem must support file locks.
 * Uncooperative external editors and hostile filesystem replacement are outside this coordination protocol.
 */
class FileWorkspace(
    root: Path,
) : Workspace {
    private val root: Path = root.toRealPath()
    private val lockFile: Path = this.root.resolve(".workspace.lock")

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

    override fun exists(path: String): Boolean = resolve(path).isRegularFile()

    override fun write(
        path: String,
        text: String,
        expectedVersion: String?,
    ): String =
        mutate(path) { file ->
            if (expectedVersion != null) {
                val current = if (file.isRegularFile()) DocumentVersion.of(Files.readString(file)) else null
                if (current != expectedVersion) throw VersionConflictException(path, expectedVersion, current)
            }
            store(file, text)
        }

    override fun create(
        path: String,
        text: String,
    ): String =
        mutate(path) { file ->
            Files.createDirectories(file.parent)
            try {
                Files.write(file, text.toByteArray(Charsets.UTF_8), CREATE_NEW, WRITE)
            } catch (_: FileAlreadyExistsException) {
                throw DocumentExistsException(path)
            }
            DocumentVersion.of(text)
        }

    private fun mutate(
        path: String,
        action: (Path) -> String,
    ): String =
        synchronized(mutationMonitor) {
            FileChannel.open(lockFile, CREATE, WRITE, NOFOLLOW_LINKS).use { channel ->
                channel.lock().use {
                    val file = resolve(path)
                    if (file.startsWith(lockFile) || (Files.exists(file) && Files.isSameFile(file, lockFile))) {
                        throw InvalidDocumentPathException(path)
                    }
                    action(file)
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
