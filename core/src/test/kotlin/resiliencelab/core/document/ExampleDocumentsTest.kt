package resiliencelab.core.document

import org.assertj.core.api.Assertions.assertThat
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class ExampleDocumentsTest {
    @Test
    fun `example documents are in canonical form`() {
        Files.walk(Path.of("../examples")).use { paths ->
            val documents = paths.filter { it.fileName.toString().matches(Regex(".*\\.(model|layout|experiment)\\.json")) }.toList()
            assertThat(documents).isNotEmpty()
            documents.forEach { file ->
                val text = Files.readString(file)
                val canonical =
                    when {
                        file.toString().endsWith(".model.json") ->
                            DocumentCodec.encodeModel((DocumentCodec.decodeModel(text, file.toString()) as DecodeResult.Ok).value)
                        file.toString().endsWith(".layout.json") ->
                            DocumentCodec.encodeLayout((DocumentCodec.decodeLayout(text, file.toString()) as DecodeResult.Ok).value)
                        else ->
                            DocumentCodec.encodeExperiment((DocumentCodec.decodeExperiment(text, file.toString()) as DecodeResult.Ok).value)
                    }
                assertThat(canonical).describedAs(file.toString()).isEqualTo(text)
            }
        }
    }
}
