package resiliencelab.server.lab

import java.nio.file.Files
import java.nio.file.Path

/** Copies the example workspace into a temporary directory, so tests may change documents and write runs. */
object TestWorkspace {
    fun copy(): Path {
        val source = Path.of(requireNotNull(System.getProperty("resilience-lab.workspace")))
        val target = Files.createTempDirectory("lab-api")
        Files.walk(source).use { paths ->
            paths
                .filter { Files.isRegularFile(it) }
                .map { source.relativize(it) }
                .filter { relative -> relative.none { it.toString().startsWith(".") } }
                .forEach { relative ->
                    val destination = target.resolve(relative.toString())
                    Files.createDirectories(destination.parent)
                    Files.copy(source.resolve(relative), destination)
                }
        }
        return target
    }
}
