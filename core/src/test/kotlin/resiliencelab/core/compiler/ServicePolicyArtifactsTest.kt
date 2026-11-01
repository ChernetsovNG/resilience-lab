package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ModelFile
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path

class ServicePolicyArtifactsTest {
    @Test
    fun `service policy artifacts repeat across workers and document order`(
        @TempDir root: Path,
    ) {
        val model =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":7,"blocks":{
                      "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"1000/s"}]},"deadline":"100ms"}},
                      "entry":{"type":"service","params":{"handlers":1,"queue":10,"replicas":2,
                        "processing":{"kind":"fixed","mean":"10ms"},
                        "rateLimit":{"rate":"100/s","burst":2},
                        "healthCheck":{"interval":"5ms","timeout":"1ms","unhealthyThreshold":1,"processing":"0.5ms"}}}
                    },"connections":[{"id":"request","type":"request","from":"client","to":"entry"}]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val experiment =
            """{"schemaVersion":4,"modelRef":"m.model.json",
              "execution":{"replications":8,"warmup":"20ms","measurement":"200ms","window":"10ms","seed":42},
              "variants":[{"id":"baseline"}]}"""

        fun run(
            source: ModelFile,
            workers: Int,
        ): Map<String, ByteArray> {
            val directory = Files.createDirectories(root.resolve("workers-$workers"))
            Files.writeString(directory.resolve("m.model.json"), DocumentCodec.encodeModel(source))
            Files.writeString(directory.resolve("e.experiment.json"), experiment)
            val outcome =
                ExperimentExecutor(workers).use { executor ->
                    Lab(FileWorkspace(directory), executor = executor).use { lab -> lab.run("e.experiment.json", "run") }
                }
            val artifact = directory.resolve(outcome.runDirectory)
            return Files.walk(artifact).use { files ->
                files.filter(Files::isRegularFile).toList().associate {
                    artifact.relativize(it).toString() to Files.readAllBytes(it)
                }
            }
        }

        val expected = run(model, 1)
        val shuffled =
            model.copy(
                blocks =
                    model.blocks.entries
                        .reversed()
                        .associate { it.toPair() },
                connections = model.connections.reversed(),
            )
        for (workers in listOf(2, 4, 8)) {
            val actual = run(shuffled, workers)
            assertThat(actual.keys).containsExactlyInAnyOrderElementsOf(expected.keys)
            expected.forEach { (path, bytes) -> assertThat(actual.getValue(path)).describedAs("$workers/$path").isEqualTo(bytes) }
        }
    }
}
