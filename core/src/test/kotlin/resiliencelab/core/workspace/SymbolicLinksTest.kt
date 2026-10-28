package resiliencelab.core.workspace

import org.assertj.core.api.Assertions.assertThat
import java.nio.file.FileSystemException
import kotlin.test.Test

class SymbolicLinksTest {
    @Test
    fun `recognizes only Windows missing privilege failures`() {
        assertThat(
            isMissingSymlinkPrivilege(
                FileSystemException("link", null, "A required privilege is not held by the client"),
                "Windows 11",
            ),
        ).isTrue()
        assertThat(
            isMissingSymlinkPrivilege(FileSystemException("link", null, "Клиент не обладает требуемыми правами"), "Windows 11"),
        ).isTrue()
        assertThat(isMissingSymlinkPrivilege(FileSystemException("link", null, "Read-only file system"), "Windows 11"))
            .isFalse()
        assertThat(isMissingSymlinkPrivilege(FileSystemException("link", null, "Privilege denied"), "Linux"))
            .isFalse()
    }
}
