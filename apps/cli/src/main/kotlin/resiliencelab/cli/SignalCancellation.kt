package resiliencelab.cli

import sun.misc.Signal
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Converts SIGINT and SIGTERM into a cooperative request. The command can finish artifact writes and return 130
 * through main instead of the JVM's default signal exit. Previous handlers are restored when the command returns.
 * A repeated SIGINT forces exit 130 without waiting for artifact writes.
 */
internal class SignalCancellation : AutoCloseable {
    private val requested = AtomicBoolean()
    private val handlers =
        listOf("INT", "TERM").associate { name ->
            val signal = Signal(name)
            signal to
                Signal.handle(signal) { received ->
                    if (requested.getAndSet(true) && received.name == "INT") Runtime.getRuntime().halt(130)
                }
        }

    fun isCancelled(): Boolean = requested.get()

    override fun close() {
        handlers.forEach { (signal, handler) -> Signal.handle(signal, handler) }
    }
}
