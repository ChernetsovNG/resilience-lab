package resiliencelab.core.workspace

import kotlinx.serialization.Serializable
import java.io.IOException
import java.io.UncheckedIOException
import java.nio.file.ClosedWatchServiceException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardWatchEventKinds.ENTRY_CREATE
import java.nio.file.StandardWatchEventKinds.ENTRY_DELETE
import java.nio.file.StandardWatchEventKinds.ENTRY_MODIFY
import java.nio.file.WatchKey
import java.nio.file.WatchService
import java.nio.file.attribute.BasicFileAttributes
import java.time.Duration
import java.util.UUID
import java.util.concurrent.TimeUnit.MILLISECONDS
import kotlin.concurrent.thread

/** Workspace document kinds by file suffix (ADR 0005). */
@Serializable
enum class DocumentKind(
    val suffix: String,
) {
    MODEL(".model.json"),
    LAYOUT(".layout.json"),
    EXPERIMENT(".experiment.json"),
    ;

    companion object {
        fun of(path: String): DocumentKind? = entries.firstOrNull { path.endsWith(it.suffix) }
    }
}

/** Opaque cursor: [generation] identifies the process journal and [sequence] orders its changes. */
data class WorkspaceCursor(
    val generation: String,
    val sequence: Long,
) {
    init {
        require(sequence >= 0) { "Cursor sequence must be non-negative" }
        require(runCatching { UUID.fromString(generation).toString() == generation }.getOrDefault(false)) {
            "Cursor generation must be a canonical UUID"
        }
    }

    override fun toString(): String = "$generation:$sequence"

    companion object {
        fun parse(value: String): WorkspaceCursor {
            val parts = value.split(':')
            require(parts.size == 2) { "Cursor must have generation and sequence" }
            val sequence = parts[1].toLongOrNull()
            require(sequence != null) { "Cursor sequence must be a decimal integer" }
            return WorkspaceCursor(parts[0], sequence)
        }
    }
}

/** One document mutation; [version] is null after deletion. */
data class WorkspaceChange(
    val path: String,
    val kind: DocumentKind,
    val version: String?,
)

/** Changes after a cursor, or a reset request when the cursor is no longer represented in the journal. */
data class WorkspaceChangeBatch(
    val cursor: WorkspaceCursor,
    val reset: Boolean,
    val changes: List<WorkspaceChange>,
)

private data class JournalEntry(
    val cursor: Long,
    val change: WorkspaceChange,
)

/** In-memory journal backed by filesystem events and full scans, so missed platform events do not hide changes. */
internal class WorkspaceChangeJournal(
    private val root: Path,
    private val scanInterval: Duration,
    private val historyLimit: Int,
    private val mutationMonitor: Any,
    private val watchServiceFactory: () -> WatchService = { root.fileSystem.newWatchService() },
) : AutoCloseable {
    private val monitor = Any()
    private val generation = UUID.randomUUID().toString()
    private val observed = mutableMapOf<String, String>()
    private val entries = ArrayDeque<JournalEntry>()
    private val registrations = mutableMapOf<Path, WatchKey>()
    private var cursor = 0L
    private var initialized = false
    private var worker: Thread? = null
    private var watcher: WatchService? = null

    @Volatile
    private var closed = false

    init {
        require(!scanInterval.isZero && !scanInterval.isNegative) { "Scan interval must be positive" }
        require(historyLimit > 0) { "History limit must be positive" }
    }

    /** Records a mutation already serialized with scans through [mutationMonitor]. */
    fun record(
        path: String,
        version: String?,
    ) {
        if (!isDocumentPath(path)) return
        synchronized(monitor) {
            updateObserved(path, version)
            append(path, version)
        }
    }

    fun changes(since: WorkspaceCursor?): WorkspaceChangeBatch {
        synchronized(mutationMonitor) {
            initialize()
        }
        start()
        synchronized(mutationMonitor) {
            refresh()
        }
        return synchronized(monitor) {
            val current = WorkspaceCursor(generation, cursor)
            if (since == null) return@synchronized WorkspaceChangeBatch(current, reset = false, changes = emptyList())
            val oldest = entries.firstOrNull()?.cursor ?: (cursor + 1)
            if (since.generation != generation || since.sequence > cursor || since.sequence < oldest - 1) {
                return@synchronized WorkspaceChangeBatch(current, reset = true, changes = emptyList())
            }
            WorkspaceChangeBatch(
                current,
                reset = false,
                changes = entries.filter { it.cursor > since.sequence }.map { it.change },
            )
        }
    }

    private fun start() {
        synchronized(monitor) {
            check(!closed) { "Workspace is closed" }
            if (worker != null) return
            var service = createWatchService()
            watcher = service
            if (service != null) {
                try {
                    registerDirectories()
                } catch (_: IOException) {
                    service = null
                } catch (_: UncheckedIOException) {
                    service = null
                } catch (_: UnsupportedOperationException) {
                    service = null
                } catch (_: SecurityException) {
                    service = null
                }
                if (service == null) {
                    runCatching { watcher?.close() }
                    watcher = null
                    registrations.clear()
                }
            }
            worker =
                thread(isDaemon = true, name = "workspace-changes") {
                    watchLoop(service)
                }
        }
    }

    private fun createWatchService(): WatchService? =
        try {
            watchServiceFactory()
        } catch (_: IOException) {
            null
        } catch (_: UnsupportedOperationException) {
            null
        } catch (_: SecurityException) {
            null
        }

    private fun watchLoop(service: WatchService?) {
        while (!closed) {
            try {
                if (service == null) {
                    Thread.sleep(scanInterval.toMillis())
                } else {
                    val key = service.poll(scanInterval.toMillis(), MILLISECONDS)
                    if (key != null) {
                        key.pollEvents()
                        key.reset()
                    }
                }
            } catch (_: ClosedWatchServiceException) {
                break
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
            try {
                synchronized(mutationMonitor) {
                    registerDirectories()
                    refresh()
                }
            } catch (_: IOException) {
                // The next scan retries transient filesystem failures.
            } catch (_: UncheckedIOException) {
                // The next scan retries transient directory traversal failures.
            } catch (_: SecurityException) {
                // The next scan retries transient filesystem access failures.
            }
        }
    }

    private fun registerDirectories() {
        val service = watcher ?: return
        val live = mutableSetOf<Path>()
        walkVisibleWorkspace(
            root,
            object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(
                    dir: Path,
                    attrs: BasicFileAttributes,
                ): FileVisitResult {
                    live.add(dir)
                    if (!registrations.containsKey(dir)) {
                        registrations[dir] = dir.register(service, ENTRY_CREATE, ENTRY_MODIFY, ENTRY_DELETE)
                    }
                    return FileVisitResult.CONTINUE
                }
            },
        )
        val stale = registrations.filterKeys { it !in live || !registrations.getValue(it).isValid }.keys
        stale.forEach {
            registrations.remove(it)?.cancel()
        }
    }

    /** Captures initial documents as baseline without emitting them; earlier API events remain in the journal. */
    private fun initialize() {
        if (initialized) return
        val baseline = snapshot()
        synchronized(monitor) {
            if (initialized) return
            observed.putAll(baseline)
            initialized = true
        }
    }

    /** Must be called with [mutationMonitor] held, in the same order as workspace mutations. */
    private fun refresh() {
        val current = snapshot()
        synchronized(monitor) {
            (observed.keys + current.keys).sorted().forEach { path ->
                val previous = observed[path]
                val version = current[path]
                if (previous != version) {
                    updateObserved(path, version)
                    append(path, version)
                }
            }
        }
    }

    private fun snapshot(): Map<String, String> {
        val result = mutableMapOf<String, String>()
        try {
            walkVisibleWorkspace(
                root,
                object : SimpleFileVisitor<Path>() {
                    override fun visitFile(
                        file: Path,
                        attrs: BasicFileAttributes,
                    ): FileVisitResult {
                        if (attrs.isRegularFile) {
                            val path = root.relativize(file).joinToString("/")
                            if (DocumentKind.of(path) != null) {
                                try {
                                    result[path] = DocumentVersion.of(Files.readAllBytes(file))
                                } catch (_: IOException) {
                                    // A concurrent editor can remove a file between listing and reading; the next scan retries.
                                }
                            }
                        }
                        return FileVisitResult.CONTINUE
                    }
                },
            )
        } catch (exception: UncheckedIOException) {
            throw exception.cause ?: IOException("Workspace scan failed", exception)
        }
        return result
    }

    private fun isDocumentPath(path: String): Boolean = DocumentKind.of(path) != null && path.split('/').none { it.startsWith(".") }

    private fun updateObserved(
        path: String,
        version: String?,
    ) {
        if (version == null) observed.remove(path) else observed[path] = version
    }

    private fun append(
        path: String,
        version: String?,
    ) {
        val kind = DocumentKind.of(path) ?: return
        entries += JournalEntry(++cursor, WorkspaceChange(path, kind, version))
        while (entries.size > historyLimit) entries.removeFirst()
    }

    override fun close() {
        val running: Thread?
        synchronized(monitor) {
            if (closed) return
            closed = true
            running = worker
            runCatching { watcher?.close() }
        }
        running?.interrupt()
        running?.join(5_000)
    }
}
