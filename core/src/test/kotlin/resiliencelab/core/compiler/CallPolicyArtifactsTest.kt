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

class CallPolicyArtifactsTest {
    @Test
    fun `policy artifacts repeat byte for byte across workers and document order`(
        @TempDir root: Path,
    ) {
        val model =
            (
                DocumentCodec.decodeModel(
                    """{"schemaVersion":6,"blocks":{
              "client":{"type":"client","params":{"load":{"points":[{"time":"0s","rate":"300/s"}]},"deadline":"100ms"}},
              "entry":{"type":"service","params":{"handlers":4,"replicas":2,"processing":{"kind":"fixed","mean":"0ms"}}},
              "backend":{"type":"service","params":{"handlers":4,"processing":{"kind":"fixed","mean":"2ms"},"failureRate":"70%"}}
            },"connections":[
              {"id":"request","type":"request","from":"client","to":"entry"},
              {"id":"call","type":"call","from":"entry","to":"backend","params":{"timeout":"10ms","attempts":4,
                "circuitBreaker":{"minimumCalls":2,"window":4,"openDuration":"10ms","halfOpenCalls":2},
                "retryBudget":{"ratio":"20%","minPerSecond":"10/s","window":"50ms"},
                "fallback":{"on":["error","circuitOpen"],"processing":"1ms"}}}
            ]}""",
                    "m.model.json",
                ) as DecodeResult.Ok
            ).value
        val experiment =
            """{"schemaVersion":3,"modelRef":"m.model.json",
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
