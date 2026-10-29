import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, experiment, manifest, model, summary } from "../../test/fixtures";
import { Timeline } from "./Timeline";
import { seriesLoader, type DecodedConnection, type NodeSeriesMetrics } from "../series";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function stubSeries() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const nodes: NodeSeriesMetrics[] = [{ id: "gateway", windows: [0, 10, 20].map((startMs) => ({
    startMs, durationMs: startMs === 20 ? 5 : 10, originalArrivalsPerSecond: 0, offeredAttemptsPerSecond: 500,
    admittedAttemptsPerSecond: 400, queueRejectionsPerSecond: 100, successesPerSecond: 300, failuresPerSecond: 100,
    timeoutsPerSecond: 100, retriesPerSecond: 200, handlerUtilization: 0.75, meanQueueLength: 1,
    meanLatencyMs: 10, p50LatencyMs: 8, p95LatencyMs: 20, p99LatencyMs: 25, amplification: 1.2,
  })) }];
  const connections: DecodedConnection[] = [{ id: "gateway-to-middle", windows: [0, 10, 20].map((startMs) => ({
    startMs, durationMs: startMs === 20 ? 5 : 10, sentAttempts: startMs === 20 ? 0 : 3, retries: 1,
    succeeded: 1, failed: 1, timeouts: 1, orphaned: 1, inFlightIntegralMs: 20, orphanedIntegralMs: 4,
    backoffIntegralMs: 5, latency: { count: 2, sumMs: 12, meanMs: 6, p50Ms: 4, p95Ms: 8, p99Ms: 8 },
  })) }];
  vi.spyOn(seriesLoader, "load").mockImplementation(async (request) => nodes.filter((node) => request.nodes.includes(node.id)));
  vi.spyOn(seriesLoader, "loadConnections").mockImplementation(async (request) => connections.filter((connection) => request.connections.includes(connection.id)));
}

const shortManifest = { ...manifest, series: { ...manifest.series!, warmupMs: 10, measurementMs: 15 } };


it("does not substitute another variant when the selected variant is absent from the run", () => {
  render(<Timeline runId="run-1" summary={summary} manifest={manifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="new-variant" pointId="p0" replication={0} cursorWindow={null} selectedNodes={[]} />);
  expect(screen.getByText("The selected variant is not available in this run.")).toBeTruthy();
  expect(screen.queryByText("Baseline (baseline)")).toBeNull();
});

it("shows a selected call's own rates, waiting state and response latency", async () => {
  stubSeries();
  render(<Timeline runId="run-call" summary={summary} manifest={shortManifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={1} selectedNodes={["gateway-to-middle"]} />);

  const rates = await screen.findByRole("region", { name: "Rates" });
  expect(within(rates).getByText("gateway-to-middle · Sent attempts")).toBeTruthy();
  expect(within(rates).getByText("300 RPS")).toBeTruthy();
  expect(within(rates).getByText("gateway-to-middle · Retries")).toBeTruthy();
  expect(within(rates).getByText("gateway-to-middle · Successes")).toBeTruthy();
  const errors = screen.getByRole("region", { name: "Errors and rejections" });
  expect(within(errors).getByText("gateway-to-middle · Timeouts")).toBeTruthy();
  const state = screen.getByRole("region", { name: "Call state" });
  expect(within(state).getByText("2 requests")).toBeTruthy();
  expect(within(state).getByText("0.4 requests")).toBeTruthy();
  expect(within(state).getByText("0.5 requests")).toBeTruthy();
  const latency = screen.getByRole("region", { name: "Latency" });
  expect(within(latency).getByText("gateway-to-middle · Mean latency")).toBeTruthy();
  expect(within(latency).getByText("6 ms")).toBeTruthy();
  expect(within(latency).getAllByText("8 ms")).toHaveLength(2);
});

it("keeps a Ctrl-selected service alongside a call and follows a replacement canvas selection", async () => {
  stubSeries();
  const props = { runId: "run-mixed", summary, manifest: shortManifest, model, experiment, catalog,
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 1 };
  const view = render(<Timeline {...props} selectedNodes={["gateway", "gateway-to-middle"]} />);
  await screen.findByText("gateway-to-middle · Sent attempts");
  expect(screen.getByText("gateway · Handler utilization · Baseline (baseline)")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "gateway" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "gateway-to-middle" }) as HTMLInputElement).checked).toBe(true);

  view.rerender(<Timeline {...props} selectedNodes={["middle-to-dependency"]} />);
  await waitFor(() => expect(screen.queryByText("gateway-to-middle · Sent attempts")).toBeNull());
  expect(screen.queryByText("gateway · Handler utilization · Baseline (baseline)")).toBeNull();
});

it("shows each variant's effective timeout after applying the selected grid point", async () => {
  stubSeries();
  const selectedSummary = structuredClone(summary);
  selectedSummary.variants[0].points[0].coordinates = { "gateway-to-middle.timeout": "0.025s" };
  const selectedExperiment = structuredClone(experiment);
  selectedExperiment.variants[0].overrides = { "gateway-to-middle.timeout": "50ms" };
  selectedExperiment.variants[1].overrides = { "gateway-to-middle.timeout": "70ms" };
  render(<Timeline runId="run-timeout" summary={selectedSummary} manifest={shortManifest} model={model} experiment={selectedExperiment}
    catalog={catalog} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={1} selectedNodes={["gateway-to-middle"]} />);

  const latency = await screen.findByRole("region", { name: "Latency" });
  expect(within(latency).getByText("gateway-to-middle timeout · Baseline (baseline)")).toBeTruthy();
  expect(within(latency).getByText("25 ms")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "no-retries" } });
  await waitFor(() => expect(within(latency).getByText("gateway-to-middle timeout · No retries (no-retries)")).toBeTruthy());
  expect(within(latency).getByText("70 ms")).toBeTruthy();
});


it("restores an element hidden with Timeline checkboxes on a new Show on Timeline request", async () => {
  stubSeries();
  const props = { runId: "run-show", summary, manifest: shortManifest, model, experiment, catalog,
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 1, selectedNodes: ["gateway-to-middle"] };
  const view = render(<Timeline {...props} selectionRequest={0} />);
  await screen.findByText("gateway-to-middle · Sent attempts");
  fireEvent.click(screen.getByRole("checkbox", { name: "gateway-to-middle" }));
  await waitFor(() => expect(screen.queryByText("gateway-to-middle · Sent attempts")).toBeNull());
  view.rerender(<Timeline {...props} selectionRequest={1} />);
  expect(await screen.findByText("gateway-to-middle · Sent attempts")).toBeTruthy();
});
