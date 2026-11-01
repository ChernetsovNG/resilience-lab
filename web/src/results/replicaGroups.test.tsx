import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { catalog, layout, manifest } from "../test/fixtures";
import { replicaFixture } from "../test/replicaResults";
import { mockReactFlowDom } from "../test/reactFlow";
import { Canvas } from "../canvas/Canvas";
import { ElementResults } from "../inspector/ElementResults";
import { projectElementResults } from "../inspector/elementResultsData";
import { SummaryTable } from "../layout/SummaryTable";
import { GridMap } from "./GridMap";
import { canvasResults, utilizationColor } from "./canvasResults";
import { seriesLoader } from "./series";
import { recordedWindow } from "../test/series";

beforeAll(mockReactFlowDom);
afterEach(() => vi.restoreAllMocks());

it("shows recorded pooled and worst utilization, coloring the group by its worst replica", async () => {
  const { run, runModel, runExperiment } = replicaFixture();
  render(<Canvas catalog={catalog} model={runModel} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()}
    results={canvasResults(run, runModel, "baseline", "p0", catalog, runModel, runExperiment)} />);
  const metrics = await screen.findByTestId("canvas-results-gateway");
  expect(metrics.textContent).toContain("Util. 34% · max #2: 97%");
  expect(metrics.closest<HTMLElement>(".block-node")!.style.getPropertyValue("--node-fill")).toBe(utilizationColor(0.97));
  expect(screen.getByRole("img", { name: "First saturated node" })).toBeTruthy();
});

it("reads an instance's saved results and the merged group p99 without averaging percentiles", () => {
  const { run, runModel, runExperiment } = replicaFixture();
  const context = { summary: run, manifest, runModel, currentModel: runModel, experiment: runExperiment, catalog,
    variantId: "baseline", pointId: "p0", replication: 0, window: null, selected: "gateway#2" };
  expect(projectElementResults(context)?.values.utilization.value).toBe(0.97);
  expect(projectElementResults(context)?.values.groupP99LatencyMs.value).toBe(990);
  expect(projectElementResults({ ...context, selected: "gateway" })?.values.groupP99LatencyMs.value).toBe(876);
  const withoutGroup = { ...runModel, blocks: { ...runModel.blocks } };
  delete withoutGroup.blocks.gateway;
  expect(projectElementResults({ ...context, currentModel: withoutGroup })).toBeNull();
  expect(projectElementResults({ ...context, selected: "gateway#4" })).toBeNull();
});

it("sorts the replica table in both directions and selects a replica", () => {
  const { run, runModel, runExperiment } = replicaFixture();
  vi.spyOn(seriesLoader, "load").mockResolvedValue([]);
  vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue([]);
  run.variants[0].points[0].aggregate.services["gateway#3"].totals.slotPools.handlers.queueIntegralMs = 1000;
  run.variants[0].points[0].aggregate.services["gateway#1"].totals.slotPools.handlers.queueFullCount = 30;
  const onSelectReplica = vi.fn();
  render(<ElementResults runId="run-1" summary={run} manifest={manifest} runModel={runModel} currentModel={runModel}
    experiment={runExperiment} catalog={catalog} variantId="baseline" pointId="p0" replication={0} window={null}
    selected="gateway" onShowTimeline={vi.fn()} onSelectReplica={onSelectReplica} />);
  const table = screen.getByRole("table", { name: "Replicas · gateway" });
  fireEvent.click(within(table).getByRole("button", { name: "Resource utilization" }));
  expect(within(table).getAllByRole("row")[1].textContent).toContain("#2");
  fireEvent.click(within(table).getByRole("button", { name: "gateway#2" }));
  expect(onSelectReplica).toHaveBeenCalledExactlyOnceWith("gateway#2");
  for (const [column, first] of [["Mean queue", "#3"], ["Rejections", "#1"], ["p99 latency", "#2"]]) {
    fireEvent.click(within(table).getByRole("button", { name: column }));
    expect(within(table).getAllByRole("row")[1].textContent).toContain(first);
  }
  fireEvent.click(within(table).getByRole("button", { name: "Resource utilization" }));
  fireEvent.click(within(table).getByRole("button", { name: "Resource utilization" }));
  expect(within(table).getAllByRole("row")[1].textContent).toContain("#1");
});

it("follows the selected window in every replica row and labels the measurement summary", async () => {
  const { run, runModel, runExperiment } = replicaFixture();
  const nodes = ["gateway", "gateway#1", "gateway#2", "gateway#3"].map((id, replica) => ({ id,
    windows: [0, 1].map(index => recordedWindow({ startMs: index * 100, durationMs: 100,
      slotPools: { handlers: { busyIntegralMs: 10 * replica + index * 60, capacityIntegralMs: 100,
        queueIntegralMs: 0, queueFullCount: 0, waitCount: 0, totalWaitMs: 0, waitLimitCount: 0 } },
    })),
  }));
  vi.spyOn(seriesLoader, "load").mockImplementation(async request => nodes.filter(node => request.nodes.includes(node.id))
    .map(node => ({ ...node, windows: node.windows.slice(request.fromWindow ?? 0, request.untilWindow) })));
  const options = { runId: "replica-windows", summary: run, manifest, runModel, currentModel: runModel,
    experiment: runExperiment, catalog, variantId: "baseline", pointId: "p0", replication: 0,
    selected: "gateway", onShowTimeline: vi.fn() };
  const view = render(<ElementResults {...options} window={0} />);
  const table = () => screen.getByRole("table", { name: "Replicas · gateway" });
  const utilization = () => within(table()).getByRole("button", { name: "gateway#1" }).closest("tr")!.querySelector("td")!;
  await waitFor(() => expect(utilization().textContent).toBe("10%"));
  expect(table().querySelector("caption")!.textContent).toContain("Window 0");
  view.rerender(<ElementResults {...options} window={1} />);
  await waitFor(() => expect(utilization().textContent).toBe("70%"));
  expect(table().querySelector("caption")!.textContent).toContain("Window 1");
  vi.mocked(seriesLoader.load).mockReturnValue(new Promise(() => {}));
  view.rerender(<ElementResults {...options} replication={1} window={1} />);
  expect(utilization().textContent).toBe("n/a");
  view.rerender(<ElementResults {...options} window={null} />);
  expect(utilization().textContent).toBe("2%");
  expect(table().querySelector("caption")!.textContent).toContain("Measurement summary");
});

it("explains attempts below one in the Findings tables, including individual replicas", () => {
  const { run } = replicaFixture();
  run.variants[0].points[0].aggregate.services["gateway#1"].admittedAmplification!.mean = 0.27;
  render(<SummaryTable summary={run} />);
  const table = screen.getByRole("table", { name: "Element metrics: gateway#1" });
  expect(table.textContent).toContain("0.27×");
  expect(table.textContent).toContain("Not every request reached it");
});

it("distinguishes an absent replica in another variant from a zero-arrival result", () => {
  const { run } = replicaFixture();
  const other = structuredClone(run.variants[0]);
  other.id = "fewer-replicas";
  delete other.points[0].aggregate.services["gateway#3"];
  run.variants.push(other);
  render(<SummaryTable summary={run} />);
  const table = screen.getByRole("table", { name: "Element metrics: gateway#3" });
  const absent = within(table).getByRole("rowheader", { name: "Attempts per request" }).closest("tr")!.querySelectorAll("td")[1];
  expect(absent.textContent).not.toContain("no original requests");
  expect(absent.textContent).toContain("no recorded data in the selected context");
});

it("nests replicas inside Answer groups and links the first saturated instance", () => {
  const { run } = replicaFixture();
  const onElement = vi.fn();
  const view = render(<SummaryTable summary={run} activeVariantId="baseline" onElement={onElement} />);
  const group = screen.getByText("Group: gateway").closest("details")!;
  expect(group.open).toBe(false);
  fireEvent.click(within(group).getByText("gateway#2 metrics"));
  expect(onElement).toHaveBeenLastCalledWith("gateway#2");
  expect(view.container.querySelectorAll(".answer > .summary-services")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /gateway#2 first/ }));
  expect(onElement).toHaveBeenLastCalledWith("gateway#2");
});

it("selects the group in Map and expands its replicas inside it", () => {
  const { run } = replicaFixture();
  run.grid = [{ path: "gateway.handlers", values: [4] }];
  render(<GridMap summary={run} activeVariantId="baseline" pointId="p0" />);
  fireEvent.change(screen.getByLabelText("Map metric"), { target: { value: "handlerUtilization" } });
  const selector = screen.getByLabelText("Element on map");
  expect(within(selector).getAllByRole("option").map(option => option.textContent)).toEqual(["gateway"]);
  const group = screen.getByText("Replicas · gateway").closest("details")!;
  expect(group.open).toBe(false);
  fireEvent.click(within(group).getByRole("radio", { name: "gateway#2" }));
  expect(screen.getByRole("button", { name: /97%/ })).toBeTruthy();
});

it.each([
  { metric: "meanQueue", value: 0.15 },
  { metric: "queueRejections", value: 20 / 260 },
])("colors group $metric by its recorded worst replica with that replica's scale", async ({ metric, value }) => {
  const { run, runModel, runExperiment } = replicaFixture();
  runModel.blocks.gateway.replicaOverrides!["2"].queue = 1;
  render(<Canvas catalog={catalog} model={runModel} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()}
    nodeMetric={metric} results={canvasResults(run, runModel, "baseline", "p0", catalog, runModel, runExperiment)} />);
  const metrics = await screen.findByTestId("canvas-results-gateway");
  expect(metrics.closest<HTMLElement>(".block-node")!.style.getPropertyValue("--node-fill")).toBe(utilizationColor(value));
});

it("shows a copied connection's own results without a service-replica table", () => {
  const { run, runModel, runExperiment } = replicaFixture();
  const aggregate = run.variants[0].points[0].aggregate;
  aggregate.groups.push({ id: "gateway-to-middle", kind: "CONNECTION", instances: [{ id: "gateway-to-middle#2", replica: 2 }] });
  aggregate.connections["gateway-to-middle#2"] = {
    slotPoolSummaries: {},
    totals: {
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, sentAttempts: 10, retries: 0, succeeded: 9, failed: 1, timeouts: 1, orphaned: 0,
      inFlightIntegralMs: 100, orphanedIntegralMs: 0, backoffIntegralMs: 0, measurementMs: 2000, slotPools: {} },
    timeoutRate: { mean: 0.1, count: 2, min: 0.1, max: 0.1 },
  };
  vi.spyOn(seriesLoader, "load").mockResolvedValue([]);
  vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue([]);
  render(<ElementResults runId="run-1" summary={run} manifest={manifest} runModel={runModel} currentModel={runModel}
    experiment={runExperiment} catalog={catalog} variantId="baseline" pointId="p0" replication={0} window={null}
    selected="gateway-to-middle#2" onShowTimeline={vi.fn()} />);
  expect(screen.queryByRole("table", { name: "Replicas · gateway-to-middle" })).toBeNull();
  expect(screen.getByRole("table", { name: "Results" }).textContent).toContain("5 RPS");
});
