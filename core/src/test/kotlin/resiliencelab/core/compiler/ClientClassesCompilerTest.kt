package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import kotlin.test.Test

class ClientClassesCompilerTest {
    private val load = """{"points":[{"time":"0s","rate":"10/s"}]}"""
    private val classes = """[{"id":"read","load":$load},{"id":"write","load":$load}]"""
    private val service = """{"type":"service","params":{"handlers":10,"processing":{"kind":"fixed","mean":"1ms"}}}"""

    private fun client(params: String = "\"load\":$load") = """{"type":"client","params":{"deadline":"1s",$params}}"""

    private fun request(
        id: String,
        from: String,
        to: String,
    ) = """{"id":"$id","type":"request","from":"$from","to":"$to"}"""

    private fun compile(
        blocks: String = """"mobile":${client("\"classes\":$classes")},"entry":$service""",
        connections: String = request("request", "mobile", "entry"),
        variants: String = """[{"id":"baseline"}]""",
        extra: String = "",
    ): CompileResult {
        val model = """{"schemaVersion":${DocumentCodec.MODEL_SCHEMA_VERSION},"blocks":{$blocks},"connections":[$connections]}"""
        val experiment = """{"schemaVersion":2,"modelRef":"m.model.json",
            "execution":{"replications":5,"warmup":"0s","measurement":"1s","seed":42},
            "variants":$variants $extra}"""
        return ModelCompiler().compile(
            (DocumentCodec.decodeModel(model, "m.model.json") as DecodeResult.Ok).value,
            "m.model.json",
            (DocumentCodec.decodeExperiment(experiment, "e.experiment.json") as DecodeResult.Ok).value,
            "e.experiment.json",
        )
    }

    @Test
    fun `two clients may share an entry`() {
        val result =
            compile(
                blocks = """"mobile":${client()},"partner":${client()},"entry":$service""",
                connections = request("mobile-request", "mobile", "entry") + "," + request("partner-request", "partner", "entry"),
            )
        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isNotNull()
    }

    @Test
    fun `separate entries make all branches reachable`() {
        val result =
            compile(
                blocks = """"mobile":${client()},"partner":${client()},"entry":$service,"other":$service""",
                connections = request("mobile-request", "mobile", "entry") + "," + request("partner-request", "partner", "other"),
            )
        assertThat(result.diagnostics).isEmpty()
        assertThat(result.experiment).isNotNull()
    }

    @Test
    fun `each client needs exactly one request connection`() {
        listOf("" to 0, "," + request("second-request", "mobile", "entry") to 2).forEach { (extra, expected) ->
            val requests = if (expected == 0) "" else request("request", "mobile", "entry") + extra
            val result = compile(connections = requests)
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics).anySatisfy {
                assertThat(it.code).isEqualTo("CLIENT_REQUEST")
                assertThat(it.path).isEqualTo("mobile")
                assertThat(it.args?.get("found").toString()).isEqualTo(expected.toString())
            }
        }
    }

    @Test
    fun `client declares either load or classes`() {
        listOf("", "\"load\":$load,\"classes\":$classes").forEach { params ->
            val block = if (params.isEmpty()) """{"type":"client","params":{"deadline":"1s"}}""" else client(params)
            val result = compile(blocks = """"mobile":$block,"entry":$service""")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains("CLIENT_LOAD")
        }
        assertThat(compile().diagnostics).isEmpty()
    }

    @Test
    fun `classes have unique valid ids and default is reserved`() {
        listOf(
            """[{"id":"bad.id","load":$load}]""" to "CLASS_ID",
            """[{"id":"default","load":$load}]""" to "CLASS_RESERVED",
            """[{"id":"read","load":$load},{"id":"read","load":$load}]""" to "CLASS_DUPLICATE",
        ).forEach { (value, code) ->
            val result = compile(blocks = """"mobile":${client("\"classes\":$value")},"entry":$service""")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.code }).contains(code)
        }
    }

    @Test
    fun `class arrays and profiles retain precise invalid locations`() {
        listOf(
            "[]" to "/blocks/mobile/params/classes",
            """[{"id":12,"load":$load}]""" to "/blocks/mobile/params/classes/0/id",
            """[{"id":"read","load":{"points":[]}}]""" to "/blocks/mobile/params/classes/0/load/points",
            """[{"id":"read","load":{"points":[{"time":"0s","rate":"-1/s"}]}}]""" to
                "/blocks/mobile/params/classes/0/load/points/0/rate",
            """[{"id":"read","load":{"points":[{"time":"1s","rate":"1/s"},{"time":"0s","rate":"1/s"}]}}]""" to
                "/blocks/mobile/params/classes/0/load/points/1/time",
        ).forEach { (value, pointer) ->
            val result = compile(blocks = """"mobile":${client("\"classes\":$value")},"entry":$service""")
            assertThat(result.experiment).isNull()
            assertThat(result.diagnostics.map { it.pointer }).contains(pointer)
        }
    }

    @Test
    fun `variant replaces class list and retains error locations`() {
        val valid = compile(variants = """[{"id":"baseline"},{"id":"new","overrides":{"mobile.classes":[{"id":"status","load":$load}]}}]""")
        assertThat(valid.diagnostics).isEmpty()
        assertThat(valid.experiment).isNotNull()
        val invalid =
            compile(
                variants = """[{"id":"bad","overrides":{"mobile.classes":[
                    {"id":"read","load":{"points":[{"time":"0s","rate":"-1/s"}]}}
                ]}}]""",
            )
        assertThat(invalid.experiment).isNull()
        assertThat(invalid.diagnostics).anySatisfy {
            assertThat(it.document).isEqualTo("e.experiment.json")
            assertThat(it.pointer).isEqualTo("/variants/0/overrides/mobile.classes/0/load/points/0/rate")
            assertThat(it.variant).isEqualTo("bad")
        }
    }

    @Test
    fun `removing classes through a variant reports the override location`() {
        val result = compile(variants = """[{"id":"baseline"},{"id":"bad","overrides":{"mobile.classes":null}}]""")

        assertThat(result.experiment).isNull()
        val diagnostic = result.diagnostics.single { it.code == "CLIENT_LOAD" }
        assertThat(diagnostic.document).isEqualTo("e.experiment.json")
        assertThat(diagnostic.pointer).isEqualTo("/variants/1/overrides/mobile.classes")
        assertThat(diagnostic.variant).isEqualTo("bad")
    }

    @Test
    fun `classes cannot be swept or overridden piecemeal`() {
        val grid = compile(extra = """, "grid":[{"path":"mobile.classes","values":[$classes]}]""")
        assertThat(grid.experiment).isNull()
        assertThat(grid.diagnostics.map { it.code }).contains("GRID_PATH")
        val nested = compile(variants = """[{"id":"bad","overrides":{"mobile.classes.0.id":"status"}}]""")
        assertThat(nested.experiment).isNull()
        assertThat(nested.diagnostics.map { it.code }).contains("OVERRIDE_PATH")
    }

    private val router = """{"type":"router","params":{"policy":"roundRobin"}}"""
    private val call = """{"id":"invoke","type":"call","from":"entry","to":"router","params":{"timeout":"10ms"}}"""
    private val entryScenario = """[{"type":"process","classes":["read"]},{"type":"call","connection":"invoke","classes":["write"]}]"""

    private fun withScenario(scenario: String) = service.dropLast(1) + ",\"scenario\":$scenario}"

    private fun route(
        id: String,
        from: String,
        to: String,
        filter: String? = null,
    ) = """{"id":"$id","type":"route","from":"$from","to":"$to"${filter?.let { ",\"classes\":$it" }.orEmpty()}}"""

    @Test
    fun `IR retains both clients classes and shared entry`() {
        val result =
            compile(
                blocks = """"mobile":${client("\"classes\":$classes")},"partner":${client()},"entry":$service""",
                connections = request("mobile-request", "mobile", "entry") + "," + request("partner-request", "partner", "entry"),
            )
        val graph =
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(graph.clients.map { it.path }).containsExactly("mobile", "partner")
        assertThat(graph.clients.map { it.entry }).containsExactly("entry", "entry")
        assertThat(graph.classes).containsExactly("default", "read", "write")
        assertThat(
            graph.clients
                .first()
                .classes
                .getValue("read")
                .average(1_000.0),
        ).isEqualTo(0.01)
        assertThat(
            graph.clients
                .first()
                .load
                .average(1_000.0),
        ).isEqualTo(0.02)
    }

    @Test
    fun `scenario and route filters define the class-specific IR paths`() {
        val result =
            compile(
                blocks = """"mobile":${client(
                    "\"classes\":$classes",
                )},"entry":${withScenario(entryScenario)},"router":$router,"leaf":$service""",
                connections = request("request", "mobile", "entry") + ",$call," + route("output", "router", "leaf", "[\"write\"]"),
            )
        assertThat(result.diagnostics).isEmpty()
        val graph =
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph
        val client = graph.clients.single()
        assertThat(graph.scenario(graph.services.first(), "read").map { it::class.simpleName }).containsExactly("Process")
        assertThat(graph.callPaths(client, "read").map { it.map { call -> call.path } }.toList()).containsExactly(emptyList())
        assertThat(graph.callPaths(client, "write").map { it.map { call -> call.path } }.toList()).containsExactly(listOf("invoke"))
        assertThat(graph.routes.single().classes).containsExactly("write")
        assertThat(graph.outgoingRoutes("router", "read")).isEmpty()
    }

    @Test
    fun `all step and route filters refer to declared classes and are nonempty unique lists`() {
        listOf(
            "[\"unknown\"]" to "CLASS_UNKNOWN",
            "[]" to "CLASS_FILTER",
            "[\"read\",\"read\"]" to "CLASS_FILTER",
        ).forEach { (filter, code) ->
            val step = """[{"type":"process","classes":$filter},{"type":"call","connection":"invoke"}]"""
            val stepResult =
                compile(
                    blocks = """"mobile":${client(
                        "\"classes\":$classes",
                    )},"entry":${withScenario(step)},"router":$router,"leaf":$service""",
                    connections = request("request", "mobile", "entry") + ",$call," + route("output", "router", "leaf"),
                )
            assertThat(stepResult.experiment).isNull()
            assertThat(stepResult.diagnostics.map { it.code }).contains(code)
            val routeResult =
                compile(
                    blocks = """"mobile":${client("\"classes\":$classes")},"entry":$service,"router":$router,"leaf":$service""",
                    connections = request("request", "mobile", "entry") + ",$call," + route("output", "router", "leaf", filter),
                )
            assertThat(routeResult.experiment).isNull()
            assertThat(routeResult.diagnostics.map { it.code }).contains(code)
        }
    }

    @Test
    fun `every class reaching a router needs a route`() {
        val result =
            compile(
                blocks = """"mobile":${client("\"classes\":$classes")},"entry":$service,"router":$router,"leaf":$service""",
                connections = request("request", "mobile", "entry") + ",$call," + route("output", "router", "leaf", "[\"read\"]"),
            )
        assertThat(result.experiment).isNull()
        val diagnostic = result.diagnostics.single { it.code == "ROUTER_CLASS" }
        assertThat(diagnostic.path).isEqualTo("router")
        assertThat(diagnostic.args?.get("id").toString()).isEqualTo("\"write\"")
    }

    @Test
    fun `nested routers only require classes selected by upstream routes`() {
        val result =
            compile(
                blocks = """"mobile":${client(
                    "\"classes\":$classes",
                )},"entry":$service,"router":$router,"nested":$router,"read-leaf":$service,"write-leaf":$service""",
                connections =
                    request("request", "mobile", "entry") + ",$call," +
                        route("read-route", "router", "nested", "[\"read\"]") + "," +
                        route("write-route", "router", "write-leaf", "[\"write\"]") + "," +
                        route("nested-read", "nested", "read-leaf", "[\"read\"]"),
            )
        assertThat(result.diagnostics).isEmpty()
        val graph =
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(
            graph
                .callPaths(graph.clients.single(), "read")
                .single()
                .single()
                .to,
        ).isEqualTo("read-leaf")
        assertThat(
            graph
                .callPaths(graph.clients.single(), "write")
                .single()
                .single()
                .to,
        ).isEqualTo("write-leaf")
    }

    @Test
    fun `only routes accept structural connection class filters`() {
        val result = compile(connections = request("request", "mobile", "entry").dropLast(1) + ",\"classes\":[\"read\"]}")
        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code }).contains("CLASS_CONNECTION")
    }

    @Test
    fun `replica expansion keeps all inputs and scenario class restrictions`() {
        val replicated = withScenario(entryScenario).replace("\"handlers\":10", "\"replicas\":2,\"handlers\":10")
        val result =
            compile(
                blocks = """"mobile":${client(
                    "\"classes\":$classes",
                )},"partner":${client("\"classes\":$classes")},"entry":$replicated,"router":$router,"leaf":$service""",
                connections =
                    request("mobile-request", "mobile", "entry") + "," + request("partner-request", "partner", "entry") +
                        ",$call," + route("output", "router", "leaf", "[\"write\"]"),
            )
        assertThat(result.diagnostics).isEmpty()
        val graph =
            result.experiment!!
                .variants
                .single()
                .points
                .single()
                .graph
        assertThat(graph.clients.map { it.entry }).containsExactly("entry#lb", "entry#lb")
        assertThat(graph.entryServices.map { it.path }).containsExactly("entry#1", "entry#2")
        assertThat(graph.callPaths(graph.clients.first(), "read").map { it.size }.toList()).containsExactly(0, 0)
        assertThat(
            graph.callPaths(graph.clients.first(), "write").map { it.single().path }.toList(),
        ).containsExactly("invoke#1", "invoke#2")
    }

    @Test
    fun `model five is rejected with an explicit schema diagnostic`() {
        val result = DocumentCodec.decodeModel("""{"schemaVersion":5,"blocks":{}}""", "old.model.json") as DecodeResult.Failed
        assertThat(result.diagnostics.single().code).isEqualTo("SCHEMA_VERSION")
        assertThat(result.diagnostics.single().message).contains("5", "6")
    }
}
