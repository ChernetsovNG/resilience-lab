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
        if (!isMissingSymlinkPrivilege(exception)) throw exception
        assumeTrue(
            false,
            "Symbolic links require Windows Developer Mode or SeCreateSymbolicLinkPrivilege: ${exception.message}",
        )
        throw exception
    }

internal fun isMissingSymlinkPrivilege(
    exception: FileSystemException,
    osName: String = System.getProperty("os.name"),
): Boolean {
    val message = exception.message?.lowercase().orEmpty()
    return osName.startsWith("Windows", ignoreCase = true) && ("privilege" in message || "прав" in message)
}
