package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonPrimitive
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.execution.CostEstimator
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.GraphIr
import resiliencelab.core.ir.LoadPoint
import resiliencelab.core.ir.LoadProfile
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RouteEdge
import resiliencelab.core.ir.RouterNode
import resiliencelab.core.ir.RoutingPolicy
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.ir.ServiceStep
import kotlin.test.Test

class MultiClientLintCostTest {
    private val run = RunSettings(5, 0.0, 1_000.0, 1L, 30L, 100.0)

    @Test
    fun `deadline warnings use each client entry and deadline`() {
        val graph =
            graph(
                listOf(client("short", "slow", 10.0), client("fast", "quick", 2.0)),
                listOf(service("slow", 20.0), service("quick", 1.0)),
            )

        val warning = warnings(graph, "LINT_DEADLINE_BUDGET").single()

        assertThat(warning.path).isEqualTo("short")
        assertThat(warning.pointer).isEqualTo("/blocks/short/params/deadline")
        assertThat(warning.args).containsEntry("requiredMs", JsonPrimitive(20.0))
    }

    @Test
    fun `handler demand combines clients sharing an entry`() {
        val graph =
            graph(
                listOf(client("one", "entry", rate = 0.06), client("two", "entry", rate = 0.06)),
                listOf(service("entry", 10.0, handlers = 1)),
            )

        val warning = warnings(graph, "LINT_HANDLERS_LITTLE").single()

        assertThat(warning.path).isEqualTo("entry")
        assertThat(warning.args).containsEntry("demand", JsonPrimitive(1.2))
        assertThat(warning.args).containsEntry("ratePerSecond", JsonPrimitive(120.0))
    }

    @Test
    fun `class restricted calls do not consume another clients deadline`() {
        val graph = classifiedGraph()

        val warning = warnings(graph, "LINT_DEADLINE_BUDGET").single()

        assertThat(warning.path).isEqualTo("checkout-client")
        assertThat(warning.args).containsEntry("requiredMs", JsonPrimitive(101.0))
        assertThat(warnings(graph, "LINT_RETRY_AMPLIFICATION")).isEmpty()
    }

    @Test
    fun `cost sums class mean profiles and counts fixed events once`() {
        val graph = classifiedGraph()
        val ramp = LoadProfile(listOf(LoadPoint(0.0, 0.0), LoadPoint(1_000.0, 0.02)))
        val changed = graph.copy(clients = listOf(graph.clients[0].copy(classes = mapOf("status" to ramp)), graph.clients[1]))

        val estimate = CostEstimator.estimate(experiment(changed), 1)

        // Per replication: status 10 × 5 events, checkout 20 × 12, 10 windows and 3 fixed events.
        assertThat(estimate.expectedEvents).isEqualTo(1_515.0)
        // Two clients, two services and one call, over ten windows and five replications.
        assertThat(estimate.expectedRows).isEqualTo(250)
    }

    @Test
    fun `cost normalizes routing weights only among routes of the class`() {
        val graph =
            graph(
                listOf(
                    ClientNode(
                        listOf("client"),
                        mapOf("status" to LoadProfile.constant(0.01), "checkout" to LoadProfile.constant(0.02)),
                        1_000.0,
                        "entry",
                    ),
                ),
                listOf(
                    service("entry", 1.0),
                    service("status", 1.0),
                    service("checkout", 1.0).copy(scenario = listOf(ServiceStep.Process(), ServiceStep.Process())),
                ),
                listOf(call("select", "entry", "router")),
                listOf(RouterNode("router", RoutingPolicy.RANDOM)),
                listOf(
                    RouteEdge("status-route", "router", "status", 1.0, classes = setOf("status")),
                    RouteEdge("checkout-route", "router", "checkout", 3.0, classes = setOf("checkout")),
                ),
            )

        val estimate = CostEstimator.estimate(experiment(graph), 1)

        // Per replication: status 10 × 12, checkout 20 × 15, ten windows and three fixed events.
        assertThat(estimate.expectedEvents).isEqualTo(2_165.0)
    }

    @Test
    fun `capacity does not count a shared prefix once per router output`() {
        val graph =
            graph(
                listOf(client("client", "entry", rate = 0.04)),
                listOf(service("entry", 10.0, 1), service("one", 10.0, 1), service("two", 10.0, 1)),
                listOf(call("select", "entry", "router")),
                listOf(RouterNode("router", RoutingPolicy.ROUND_ROBIN)),
                listOf(RouteEdge("first", "router", "one"), RouteEdge("second", "router", "two")),
            )

        assertThat(warnings(graph, "LINT_HANDLERS_LITTLE")).isEmpty()
    }

    @Test
    fun `class restricted processing changes its own deadline budget`() {
        val entry =
            service("entry", 100.0).copy(
                scenario = listOf(ServiceStep.Process(classes = setOf("checkout"))),
            )
        val graph =
            graph(
                listOf(
                    client("status", "entry", 1.0, requestClass = "status"),
                    client("checkout", "entry", 50.0, requestClass = "checkout"),
                ),
                listOf(entry),
            )

        assertThat(warnings(graph, "LINT_DEADLINE_BUDGET").map { it.path }).containsExactly("checkout")
    }

    @Test
    fun `replica entry deadline is checked for each client`() {
        val graph =
            graph(
                listOf(client("short", "replicas", 5.0), client("long", "replicas", 50.0)),
                listOf(service("one", 10.0), service("two", 20.0)),
                routers = listOf(RouterNode("replicas", RoutingPolicy.ROUND_ROBIN)),
                routes = listOf(RouteEdge("one-route", "replicas", "one"), RouteEdge("two-route", "replicas", "two")),
            )

        assertThat(warnings(graph, "LINT_DEADLINE_BUDGET").map { it.path }).containsExactly("short", "short")
    }

    private fun classifiedGraph(): GraphIr {
        val entry = service("entry", 1.0).copy(scenario = listOf(ServiceStep.Process(), ServiceStep.Call("payment", setOf("checkout"))))
        return graph(
            listOf(
                client("status-client", "entry", 2.0, 0.01, "status"),
                client("checkout-client", "entry", 50.0, 0.02, "checkout"),
            ),
            listOf(entry, service("payment", 1.0)),
            listOf(call("payment", "entry", "payment")),
        )
    }

    private fun graph(
        clients: List<ClientNode>,
        services: List<ServiceNode>,
        calls: List<CallEdge> = emptyList(),
        routers: List<RouterNode> = emptyList(),
        routes: List<RouteEdge> = emptyList(),
    ) = GraphIr(clients, services, calls, emptyList(), run, routers, routes)

    private fun client(
        path: String,
        entry: String,
        deadline: Double = 1_000.0,
        rate: Double = 0.001,
        requestClass: String = "default",
    ) = ClientNode(
        listOf(path),
        mapOf(requestClass to LoadProfile.constant(rate)),
        deadline,
        entry,
        Origin("m.model.json", "/blocks/$path"),
    )

    private fun service(
        path: String,
        processing: Double,
        handlers: Int = 100,
    ) = ServiceNode(path, handlers, 0, fixed(processing), 0.0, Origin("m.model.json", "/blocks/$path"))

    private fun call(
        path: String,
        from: String,
        to: String,
    ) = CallEdge(path, from, to, fixed(0.0), 100.0, 1, Backoff(BackoffKind.NONE, 0.0, 0.0, 1.0))

    private fun fixed(value: Double) = Distribution(DistributionShape.FIXED, value)

    private fun experiment(graph: GraphIr) =
        CompiledExperiment(listOf(CompiledVariant("baseline", "Baseline", listOf(CompiledPoint("p0", emptyMap(), graph)))), run)

    private fun warnings(
        graph: GraphIr,
        code: String,
    ) = ModelLinter().lint(experiment(graph)).filter { it.code == code }
}
