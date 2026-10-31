package resiliencelab.core.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.io.TempDir
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class GridExperimentTest {
    @TempDir
    lateinit var temp: Path

    private val model =
        """
        {"schemaVersion":6,"blocks":{
          "client":{"type":"client","params":{"load": {"points": [{"time": "0s", "rate": "100/s"}]},"deadline":"10ms"}},
          "entry":{"type":"service","params":{"handlers":1,"queue":4,"processing":{"kind":"exponential","mean":"3ms"}}}
        },"connections":[{"id":"request","type":"request","from":"client","to":"entry"}]}
        """.trimIndent()
    private val grid =
        """[{"path":"entry.handlers","values":[1,2]},{"path":"client.deadline","values":["10ms","20ms","30ms"]}]"""

    private fun workspace(
        name: String,
        axes: String? = grid,
        overrides: String = "{}",
        modelText: String = model,
    ): FileWorkspace {
        val root = Files.createDirectory(temp.resolve(name))
        Files.writeString(root.resolve("m.model.json"), modelText)
        Files.writeString(
            root.resolve("e.experiment.json"),
            """
            {"schemaVersion":2,"modelRef":"m.model.json",
             "execution":{"replications":2,"warmup":"0ms","measurement":"120ms","window":"20ms","seed":42},
             "variants":[{"id":"baseline","overrides":$overrides}]
             ${axes?.let { ",\"grid\":$it" }.orEmpty()}}
            """.trimIndent(),
        )
        return FileWorkspace(root)
    }

    private fun run(
        workspace: FileWorkspace,
        workers: Int = 1,
    ): RunOutcome =
        ExperimentExecutor(workers).use { executor ->
            Lab(workspace, executor = executor).use { it.run("e.experiment.json", "r") }
        }

    private fun points(workspace: FileWorkspace) =
        Json
            .parseToJsonElement(
                workspace.read(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/summary.json").text,
            ).jsonObject
            .getValue("variants")
            .jsonArray
            .single()
            .jsonObject
            .getValue("points")
            .jsonArray
            .map { it.jsonObject }

    @Test
    fun `grid warnings retain variants and identify points when their values differ`() {
        val axes = """[{"path":"entry.processing.mean","values":["3ms","4ms"]}]"""
        val workspace = workspace("warning-values", axes, modelText = model.replace("100/s", "1000/s"))
        Lab(workspace).use { lab ->
            val warnings = lab.validate("e.experiment.json").diagnostics.filter { it.code == "LINT_HANDLERS_LITTLE" }
            assertThat(warnings).hasSize(2)
            assertThat(warnings).allSatisfy {
                assertThat(it.variant).isEqualTo("baseline")
                assertThat(it.document).isEqualTo("m.model.json")
                assertThat(it.pointer).isEqualTo("/blocks/entry/params/handlers")
            }
            assertThat(warnings[0].message).contains("p0").doesNotContain("p1")
            assertThat(warnings[1].message).contains("p1").doesNotContain("p0")
        }
    }

    @Test
    fun `a warning shared by grid points stays variant scoped without duplicate messages`() {
        val axes = """[{"path":"client.deadline","values":["10ms","20ms"]}]"""
        val workspace = workspace("warning-common", axes, modelText = model.replace("100/s", "1000/s"))
        val path = "e.experiment.json"
        val document = Json.parseToJsonElement(workspace.read(path).text).jsonObject
        val variants = document.getValue("variants").jsonArray
        val candidate = JsonObject(variants.single().jsonObject + ("id" to JsonPrimitive("candidate")))
        workspace.write(path, JsonObject(document + ("variants" to JsonArray(variants + candidate))).toString())
        Lab(workspace).use { lab ->
            val warnings = lab.validate("e.experiment.json").diagnostics.filter { it.code == "LINT_HANDLERS_LITTLE" }
            assertThat(warnings.map { it.variant }).containsExactly("baseline", "candidate")
            assertThat(warnings).allSatisfy { assertThat(it.message).doesNotContain("p0", "p1") }
        }
    }

    @Test
    fun `grid warning locations follow the overridden parameter in each point`() {
        val axes = """[{"path":"entry.handlers","values":[1,2]}]"""
        Lab(workspace("warning-origins", axes, modelText = model.replace("100/s", "1000/s"))).use { lab ->
            val warnings = lab.validate("e.experiment.json").diagnostics.filter { it.code == "LINT_HANDLERS_LITTLE" }
            assertThat(warnings.map { it.pointer }).containsExactly("/grid/0/values/0", "/grid/0/values/1")
            assertThat(warnings).allSatisfy {
                assertThat(it.variant).isEqualTo("baseline")
                assertThat(it.document).isEqualTo("e.experiment.json")
            }
            assertThat(warnings[0].message).contains("p0")
            assertThat(warnings[1].message).contains("p1")
        }
    }

    @Test
    fun `a warning present in only one grid point identifies that point`() {
        val axes = """[{"path":"entry.processing.mean","values":["20ms","3ms"]}]"""
        Lab(workspace("warning-subset", axes)).use { lab ->
            val warning = lab.validate("e.experiment.json").diagnostics.single { it.code == "LINT_HANDLERS_LITTLE" }
            assertThat(warning.variant).isEqualTo("baseline")
            assertThat(warning.message).contains("p0").doesNotContain("p1")
        }
    }

    @Test
    fun `manifest and summary retain document axis order value order and duplicates`() {
        val axes = """[{"path":"entry.handlers","values":[2,1,2]},{"path":"client.deadline","values":["30ms","10ms"]}]"""
        val workspace = workspace("axes", axes)
        run(workspace, 3)

        val expected = Json.parseToJsonElement(axes)
        listOf("manifest", "summary").forEach { name ->
            val artifact =
                Json
                    .parseToJsonElement(
                        workspace.read(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/$name.json").text,
                    ).jsonObject
            assertThat(artifact["grid"]).describedAs(name).isEqualTo(expected)
        }
    }

    @Test
    fun `two by three grid persists ordered coordinates and separate task directories`() {
        val workspace = workspace("ordered")
        val progress = mutableListOf<Pair<Int, Int>>()
        ExperimentExecutor(3).use { executor ->
            Lab(workspace, executor = executor).use { lab ->
                lab.run("e.experiment.json", "r", onProgress = { completed, total -> progress += completed to total })
            }
        }

        val points = points(workspace)
        assertThat(points.map { it.getValue("id").jsonPrimitive.content }).containsExactly("p0", "p1", "p2", "p3", "p4", "p5")
        assertThat(points.map { it.getValue("coordinates").jsonObject }).containsExactly(
            coordinates(1, "10ms"),
            coordinates(1, "20ms"),
            coordinates(1, "30ms"),
            coordinates(2, "10ms"),
            coordinates(2, "20ms"),
            coordinates(2, "30ms"),
        )
        assertThat(progress).containsExactlyElementsOf((1..12).map { it to 12 })
        assertThat(
            workspace.listFiles(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r").count {
                it.endsWith("/replication.json.gz")
            },
        ).isEqualTo(12)
        for (point in 0..5) {
            for (replication in 0..1) {
                assertThat(
                    workspace.exists(
                        ".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/series/baseline/p$point/rep-$replication/index.json",
                    ),
                ).isTrue()
            }
        }
        val manifest =
            Json
                .parseToJsonElement(
                    workspace.read(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/manifest.json").text,
                ).jsonObject
        assertThat(
            manifest
                .getValue("series")
                .jsonObject
                .getValue("points")
                .jsonArray
                .map { it.jsonObject.getValue("coordinates") },
        ).isEqualTo(points.map { it.getValue("coordinates") })
    }

    @Test
    fun `baseline point equals no grid and grid values supersede variant overrides`() {
        val original = workspace("original", axes = null)
        val grid = workspace("grid")
        val overridden = workspace("overridden", overrides = """{"entry.handlers":9}""")
        run(original)
        run(grid)
        run(overridden)

        assertThat(points(original).single().getValue("coordinates").jsonObject).isEmpty()
        listOf("manifest", "summary").forEach { name ->
            val artifact =
                Json
                    .parseToJsonElement(
                        original.read(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/$name.json").text,
                    ).jsonObject
            assertThat(artifact["grid"]).isEqualTo(Json.parseToJsonElement("[]"))
        }
        assertThat(points(grid).first().getValue("aggregate")).isEqualTo(points(original).single().getValue("aggregate"))
        assertThat(points(overridden)).isEqualTo(points(grid))
        assertThat(
            grid.readBytes(
                ".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/series/baseline/p0/rep-0/replication.json.gz",
            ),
        ).isEqualTo(
            original.readBytes(
                ".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/series/baseline/p0/rep-0/replication.json.gz",
            ),
        )
    }

    @Test
    fun `identical points share random numbers and nested grid objects replace variant field overrides`() {
        val axes = """[{"path":"entry.processing","values":[{"kind":"exponential","mean":"3ms"},{"kind":"exponential","mean":"3ms"}]}]"""
        val workspace = workspace("paired", axes, overrides = """{"entry.processing.mean":"9ms"}""")
        val baseline = workspace("paired-baseline", axes = null)
        run(workspace, 2)
        run(baseline)

        val points = points(workspace)
        assertThat(points[1].getValue("aggregate")).isEqualTo(points[0].getValue("aggregate"))
        assertThat(points[0].getValue("aggregate")).isEqualTo(points(baseline).single().getValue("aggregate"))
        assertThat(
            workspace.readBytes(
                ".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/series/baseline/p1/rep-0/replication.json.gz",
            ),
        ).isEqualTo(
            workspace.readBytes(
                ".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r/series/baseline/p0/rep-0/replication.json.gz",
            ),
        )
    }

    @Test
    fun `grid artifact bytes are independent of workers and block order`() {
        val sequential = workspace("one")
        val parallel = workspace("three")
        val parsed = Json.parseToJsonElement(model).jsonObject
        val reorderedModel =
            JsonObject(
                parsed + (
                    "blocks" to
                        JsonObject(
                            parsed
                                .getValue("blocks")
                                .jsonObject
                                .toList()
                                .reversed()
                                .toMap(),
                        )
                ),
            )
        val reordered = workspace("reordered", modelText = reorderedModel.toString())
        run(sequential)
        run(parallel, 3)
        run(reordered, 3)

        val files = sequential.listFiles(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r")
        assertThat(parallel.listFiles(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r")).isEqualTo(files)
        assertThat(reordered.listFiles(".results/35bb6fa423da5447e955dbd3e9428d2ddd1b8a0cb3dda99386dcc310f5980537/r")).isEqualTo(files)
        files.forEach { path ->
            assertThat(parallel.readBytes(path)).describedAs(path).isEqualTo(sequential.readBytes(path))
            assertThat(reordered.readBytes(path)).describedAs(path).isEqualTo(sequential.readBytes(path))
        }
    }

    @Test
    fun `invalid axis paths and values point to their grid origins`() {
        val cases =
            listOf(
                """[{"path":"missing.handlers","values":[1]}]""" to "/grid/0/path",
                """[{"path":"entry.handlers","values":[1,0]}]""" to "/grid/0/values/1",
                """[{"path":"entry.processing.mean","values":["bad"]}]""" to "/grid/0/values/0",
                """[{"path":"entry.handlers","values":[]}]""" to "/grid/0/values",
                """[{"path":"entry.handlers","values":[1]},{"path":"entry.handlers","values":[2]}]""" to "/grid/1/path",
                (
                    """[{"path":"entry.handlers","values":[1]},{"path":"client.deadline","values":["10ms"]},""" +
                        """{"path":"entry.queue","values":[1]}]"""
                ) to
                    "/grid",
            )
        cases.forEachIndexed { index, (axes, pointer) ->
            Lab(workspace("invalid-$index", axes)).use { lab ->
                val report = lab.validate("e.experiment.json")
                assertThat(report.valid).describedAs(axes).isFalse()
                assertThat(report.diagnostics).anySatisfy {
                    assertThat(it.document).isEqualTo("e.experiment.json")
                    assertThat(it.pointer).isEqualTo(pointer)
                }
            }
        }
    }

    @Test
    fun `conditional distribution errors identify the grid value that changes the rule`() {
        val fixed = model.replace("\"exponential\"", "\"fixed\"")
        val lognormal =
            model
                .replace("\"exponential\"", "\"lognormal\"")
                .replace("\"mean\":\"3ms\"", "\"mean\":\"3ms\",\"stdDev\":\"1ms\"")
        val cases =
            listOf(
                Triple(model, "lognormal", "{}"),
                Triple(lognormal, "fixed", "{}"),
                Triple(fixed.replace("\"mean\":\"3ms\"", "\"mean\":\"0ms\""), "exponential", "{}"),
                Triple(fixed, "exponential", """{"entry.processing.mean":"0ms"}"""),
            )
        cases.forEachIndexed { index, (source, kind, overrides) ->
            val axes = """[{"path":"entry.processing.kind","values":["$kind"]}]"""
            Lab(workspace("conditional-$index", axes, overrides, source)).use { lab ->
                val report = lab.validate("e.experiment.json")
                assertThat(report.valid).isFalse()
                assertThat(report.diagnostics).anySatisfy {
                    assertThat(it.document).isEqualTo("e.experiment.json")
                    assertThat(it.pointer).isEqualTo("/grid/0/values/0")
                }
            }
        }
    }

    private fun coordinates(
        handlers: Int,
        deadline: String,
    ) = Json.parseToJsonElement("""{"entry.handlers":$handlers,"client.deadline":"$deadline"}""").jsonObject
}
