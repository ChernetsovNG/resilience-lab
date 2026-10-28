package resiliencelab.core.workspace

import org.junit.jupiter.api.Assumptions.assumeTrue
import java.nio.file.FileAlreadyExistsException
import java.nio.file.FileSystemException
import java.nio.file.Files
import java.nio.file.Path

internal fun createSymbolicLink(
    link: Path,
    target: Path,
): Path =
    try {
        Files.createSymbolicLink(link, target)
    } catch (exception: FileAlreadyExistsException) {
        throw exception
    } catch (exception: FileSystemException) {
        if (!System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) throw exception
        assumeTrue(
            false,
            "Symbolic links require Windows Developer Mode or SeCreateSymbolicLinkPrivilege: ${exception.message}",
        )
        throw exception
    }
