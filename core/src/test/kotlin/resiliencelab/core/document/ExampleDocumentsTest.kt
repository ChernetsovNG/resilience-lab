package resiliencelab.core.document

import org.assertj.core.api.Assertions.assertThat
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class ExampleDocumentsTest {
    private val directory = Path.of("../examples/retry-storm")

    @Test
    fun `example documents are in canonical form`() {
        val model = Files.readString(directory.resolve("retry-storm.model.json"))
        val layout = Files.readString(directory.resolve("retry-storm.layout.json"))
        val experiment = Files.readString(directory.resolve("retry-storm.experiment.json"))

        assertThat(DocumentCodec.encodeModel((DocumentCodec.decodeModel(model, "m") as DecodeResult.Ok).value)).isEqualTo(model)
        assertThat(DocumentCodec.encodeLayout((DocumentCodec.decodeLayout(layout, "l") as DecodeResult.Ok).value)).isEqualTo(layout)
        assertThat(DocumentCodec.encodeExperiment((DocumentCodec.decodeExperiment(experiment, "e") as DecodeResult.Ok).value))
            .isEqualTo(experiment)
    }
}
