import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Catalog, TypeDescriptor } from "../api/apiTypes";
import fullCatalog from "../test/catalog.json";
import { ElementResults } from "../inspector/ElementResults";
import { catalog, experiment, manifest, model, summary } from "../test/fixtures";
import { recordedWindow } from "../test/series";
import { canvasResults, windowCanvasResults } from "./canvasResults";
import { ResultsContextBar } from "./ResultsContextBar";
import { seriesLoader } from "./series";
import { Timeline } from "./timeline/Timeline";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("a database catalog preserves the node overlay choices and values for a model without databases", () => {
  const props = { model, summary, variant: experiment.variants[0],
    selection: { pointId: "p0", replication: 0, window: null }, onSelect: vi.fn(), replications: 2,
    playback: { frame: null, loading: false, problem: null, playing: false, speed: 1,
      setSpeed: vi.fn(), play: vi.fn(), pause: vi.fn(), seek: vi.fn() },
    windowCount: 1, windowMs: 100, endMs: 100, metric: "utilization", onMetricChange: vi.fn(),
    stale: false, analysis: false, onAnalysisChange: vi.fn() };
  const view = render(<ResultsContextBar {...props} catalog={catalog} />);
  const options = () => within(screen.getByRole("combobox", { name: "Node overlay" })).getAllByRole<HTMLOptionElement>("option")
    .map(option => [option.textContent, option.value]);
  const expected = [["Utilization", "utilization"], ["Mean queue", "meanQueue"], ["Queue rejections", "queueRejections"], ["Off", "off"]];
  expect(options()).toEqual(expected);
  view.rerender(<ResultsContextBar {...props} catalog={fullCatalog as Catalog} />);
  expect(options()).toEqual(expected);
});

it("uses the effective grid parameter for a catalog-defined normalized Timeline output", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const service = catalog.types.find(type => type.id === "service")!;
  const custom: TypeDescriptor = { ...service, id: "test-pool", outputs: [{
    ...service.outputs.find(output => output.id === "queueFill")!, id: "testFill", title: "Test fill",
    timeline: { group: "testFill", groupTitle: "Test fill", groupOrder: 0, order: 0 },
  }] };
  const extended = { ...catalog, types: [...catalog.types, custom] };
  const snapshot = { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, type: custom.id } } };
  const run = structuredClone(summary), input = structuredClone(experiment);
  run.variants[0].points[0].coordinates = { "gateway.queue": 8 };
  input.variants[0].overrides = { "gateway.queue": 4 };
  vi.spyOn(seriesLoader, "load").mockResolvedValue([{ id: "gateway", windows: [recordedWindow({ slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 400, capacityIntegralMs: 0, waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } })] }]);
  render(<Timeline runId="normalized" summary={run} manifest={manifest} model={snapshot} experiment={input}
    catalog={extended} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={0} selectedNodes={["gateway"]} />);
  const chart = await screen.findByRole("region", { name: "Test fill" });
  expect(within(chart).getByText("50%")).toBeTruthy();
});

it("adds a new type's output to the chart, inspector and overlay without registering it in web", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const service = catalog.types.find(type => type.id === "service")!;
  const custom: TypeDescriptor = { ...service, id: "test-pool", outputs: [{
    ...service.outputs.find(output => output.id === "admittedAttemptsPerSecond")!,
    id: "testThroughput", title: "Test throughput",
    inspector: { title: "Test throughput", order: 0, showValue: true, chartOrder: 0 },
    overlay: { title: "Test throughput", label: "Test throughput {value}", description: "Test throughput", order: 0 },
  }] };
  const extended = { ...catalog, types: [...catalog.types, custom] };
  const snapshot = { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, type: custom.id } } };
  const nodes = [{ id: "gateway", windows: [recordedWindow({ admittedAttempts: 8 })] }];
  vi.spyOn(seriesLoader, "load").mockResolvedValue(nodes);
  vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue([]);
  const result = canvasResults(summary, snapshot, "baseline", "p0", extended)!;
  expect(result.services.get("gateway")!.values.testThroughput).toBe(120);
  expect(windowCanvasResults(result, nodes, 0)!.services.get("gateway")!.values.testThroughput).toBe(80);
  const runManifest = { ...manifest, series: { ...manifest.series!, warmupMs: 0, measurementMs: 100, windowMs: 100 } };
  const playback = { frame: null, loading: false, problem: null, playing: false, speed: 1,
    setSpeed: vi.fn(), play: vi.fn(), pause: vi.fn(), seek: vi.fn() };
  render(<>
    <Timeline runId="custom" summary={summary} manifest={runManifest} model={snapshot} experiment={experiment}
      catalog={extended} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={0} selectedNodes={["gateway"]} />
    <ElementResults runId="custom" summary={summary} manifest={runManifest} runModel={snapshot} currentModel={snapshot}
      experiment={experiment} catalog={extended} variantId="baseline" pointId="p0" replication={0} window={null}
      selected="gateway" onShowTimeline={vi.fn()} />
    <ResultsContextBar catalog={extended} model={snapshot} summary={summary} variant={experiment.variants[0]}
      selection={{ pointId: "p0", replication: 0, window: null }} onSelect={vi.fn()} replications={2} playback={playback}
      windowCount={1} windowMs={100} endMs={100} metric="testThroughput" onMetricChange={vi.fn()}
      stale={false} analysis={false} onAnalysisChange={vi.fn()} />
  </>);
  const chart = await screen.findByRole("region", { name: "Rates" });
  expect(within(chart).getByText("gateway · Test throughput · Baseline")).toBeTruthy();
  expect(within(chart).getByText("80 RPS")).toBeTruthy();
  const table = screen.getByRole("table", { name: "Results" });
  await waitFor(() => expect(within(table).getByRole("rowheader", { name: "Test throughput" }).closest("tr")!.textContent).toContain("120 RPSPooled"));
  expect(within(screen.getByRole("combobox", { name: "Node overlay" })).getByRole("option", { name: "Test throughput" })).toBeTruthy();
});

it("loads a target dependency for a catalog-defined call chart and formats its multiplier", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const call = catalog.types.find(type => type.id === "call")!;
  const custom: TypeDescriptor = { ...call, outputs: [{
    ...call.outputs.find(output => output.id === "amplification")!,
    id: "testAmplification", title: "Test amplification",
    timeline: { group: "testRatio", groupTitle: "Test ratio", groupOrder: 0, order: 0 },
  }] };
  const extended = { ...catalog, types: catalog.types.map(type => type.id === custom.id ? custom : type) };
  vi.spyOn(seriesLoader, "load").mockImplementation(async request => request.nodes.includes("middle")
    ? [{ id: "middle", windows: [recordedWindow({ admittedAttempts: 6, entries: { total: { originalArrivals: 3 } } })] }] : []);
  vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue([{ id: "gateway-to-middle", windows: [{
    failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs: 0,
      durationMs: 100,
      sentAttempts: 6,
      retries: 0,
      succeeded: 6,
      failed: 0,
      timeouts: 0,
      orphaned: 0,
      inFlightIntegralMs: 0,
      orphanedIntegralMs: 0,
      backoffIntegralMs: 0,
      latency: { count: 6, sumMs: 60, meanMs: 10, p50Ms: 10, p95Ms: 10, p99Ms: 10 },
      slotPools: {  } }] }]);
  render(<Timeline runId="target" summary={summary} manifest={manifest} model={model} experiment={experiment}
    catalog={extended} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={0} selectedNodes={["gateway-to-middle"]} />);
  const chart = await screen.findByRole("region", { name: "Test ratio" });
  expect(within(chart).getByText("2×")).toBeTruthy();
});
