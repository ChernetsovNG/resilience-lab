package resiliencelab.core.workspace

import java.nio.file.Path
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit.SECONDS

/** Test-only JVM entry point exercising the real workspace and JDK filesystem lock. */
object WorkspaceWriterProcess {
    @JvmStatic
    fun main(args: Array<String>) {
        val workspace = FileWorkspace(Path.of(args[0]))
        println("READY")
        check(readln() == "GO")
        val write = FutureTask { workspace.write("shared.model.json", args[2], args[1]) }
        val worker = Thread(write, "workspace-writer")
        worker.start()
        try {
            val deadline = System.nanoTime() + SECONDS.toNanos(10)
            while (!write.isDone) {
                if (worker.stackTrace.any { it.className.startsWith("sun.nio.ch.") && it.methodName == "lock" }) {
                    println("BLOCKED")
                    break
                }
                check(System.nanoTime() < deadline) { "Writer neither blocked on the lock nor completed" }
                Thread.yield()
            }
            try {
                println("SUCCESS:${write.get(10, SECONDS)}")
            } catch (exception: java.util.concurrent.ExecutionException) {
                if (exception.cause is VersionConflictException) println("CONFLICT") else throw exception
            }
        } finally {
            worker.interrupt()
            worker.join(10_000)
            check(!worker.isAlive) { "Writer did not stop" }
        }
    }
}
