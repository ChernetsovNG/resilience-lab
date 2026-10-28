package resiliencelab.core.workspace

import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.FileVisitor
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import kotlin.io.path.pathString

/** Walks visible workspace entries without descending into hidden directories such as `.results`. */
internal fun walkVisibleWorkspace(
    root: Path,
    visitor: FileVisitor<Path>,
) {
    Files.walkFileTree(
        root,
        object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(
                dir: Path,
                attrs: BasicFileAttributes,
            ): FileVisitResult {
                if (dir != root && dir.fileName.pathString.startsWith(".")) return FileVisitResult.SKIP_SUBTREE
                return visitor.preVisitDirectory(dir, attrs)
            }

            override fun visitFile(
                file: Path,
                attrs: BasicFileAttributes,
            ): FileVisitResult {
                if (file.fileName.pathString.startsWith(".")) return FileVisitResult.CONTINUE
                return visitor.visitFile(file, attrs)
            }

            override fun visitFileFailed(
                file: Path,
                exc: IOException,
            ): FileVisitResult {
                if (file.fileName.pathString.startsWith(".")) return FileVisitResult.CONTINUE
                return visitor.visitFileFailed(file, exc)
            }

            override fun postVisitDirectory(
                dir: Path,
                exc: IOException?,
            ): FileVisitResult = visitor.postVisitDirectory(dir, exc)
        },
    )
}
