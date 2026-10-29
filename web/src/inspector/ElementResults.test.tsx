import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeriesPart } from "../api/apiTypes";
import { seriesLoader } from "../results/series";
import { decodeSeriesPart } from "../results/series/decode";
import { catalog, experiment, manifest, model, summary } from "../test/fixtures";
import { ElementResults, type ElementResultsProps } from "./ElementResults";

const raw: SeriesPart = {
  schemaVersion: 2, profile: "ddsketch-bitwise6-rational-v1", fromWindow: 0, untilWindow: 3,
  nodes: ["gateway", "middle"].map(id => ({ id, windows: [0, 100, 200].map((startMs, index) => ({
    startMs, durationMs: 100, handlers: 2, originalArrivals: 0, admittedAttempts: 8, offeredAttempts: 10,
    retries: 1, queueRejections: 2, successes: 7, failures: 1, timeouts: 1, busyHandlerTimeMs: 100, queueLengthIntegralMs: 100,
    latency: { count: index === 2 ? 9 : 1, sumMs: [999, 30, 180][index], sketch: [index === 2 ? 9 : 1] },
  })) })),
  connections: [{ id: "gateway-to-middle", windows: [0, 100, 200].map(startMs => ({
    startMs, durationMs: 100, sentAttempts: 4, retries: 1, succeeded: 1, failed: 1, timeouts: 2, orphaned: 1,
    inFlightIntegralMs: 20, orphanedIntegralMs: 10, backoffIntegralMs: 5,
    latency: { count: 2, sumMs: 24, sketch: [2] },
  })) }],
};
const decoded = decodeSeriesPart(JSON.stringify(raw));
const decodedNodes = decoded.nodes.map(node => ({ id: node.id,
  windows: node.windows.map(frame => ({ ...frame.metrics, amplification: 2.5 })), latency: node.windows.map(frame => frame.latency),
}));
function props(): ElementResultsProps {
  const run = structuredClone(summary);
  run.variants[0].points[0].aggregate.services.middle = {
    ...run.variants[0].points[0].aggregate.services.gateway,
    admittedAmplification: { mean: 2, min: 1, max: 3, ci95Low: 1, ci95High: 3 },
  };
  run.variants[0].points[0].aggregate.connections["gateway-to-middle"] = {
    totals: { measurementMs: 2000, sentAttempts: 30, retries: 10, succeeded: 20, failed: 4, timeouts: 6,
      orphaned: 4, inFlightIntegralMs: 5000, orphanedIntegralMs: 300, backoffIntegralMs: 100 },
    timeoutRate: { mean: 0.25, min: 0, max: 0.5, ci95Low: -0.1, ci95High: 0.7 },
    meanInFlight: { mean: 3, min: 2, max: 4, ci95Low: 1, ci95High: 5 },
    pooledLatency: { meanMs: 22, p95Ms: 30, p99Ms: 40, statistics: { count: 24, sumMs: 528, sketch: [24] } },
  };
  return { runId: "run", summary: run, manifest: { ...manifest, series: { ...manifest.series!, warmupMs: 100, measurementMs: 200, windowMs: 100 } },
    runModel: model, currentModel: model, experiment, catalog, variantId: "baseline", pointId: "p0", replication: 0,
    window: null, selected: "gateway", onShowTimeline: vi.fn() };
}
function loadSeries() {
  vi.spyOn(seriesLoader, "load").mockResolvedValue(decodedNodes);
  vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue(decoded.connections);
}
const row = (name: string) => within(screen.getByRole("table", { name: "Results" })).getByRole("rowheader", { name }).closest("tr")!;
afterEach(() => vi.restoreAllMocks());

describe("ElementResults", () => {
  it("labels pooled and selected-replication values, and shows run markers and catalog assumptions", async () => {
    loadSeries();
    render(<ElementResults {...props()} />);
    await waitFor(() => expect(row("Mean latency").textContent).toContain("21 ms"));
    expect(row("Handler utilization").textContent).toContain("50%Pooled");
    expect(row("Mean latency").textContent).toContain("Replication 0, measurement windows");
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(document.querySelector('[data-region="warmup"]')).toBeTruthy();
    expect(document.querySelector('[data-region="fault"]')).toBeTruthy();
    fireEvent.click(screen.getByText("Assumptions"));
    expect(screen.getByText("Handlers are held during downstream calls and backoff.")).toBeTruthy();
    expect(seriesLoader.loadConnections).not.toHaveBeenCalled();
  });
  it("shows call-owned Summary values, unclipped CI, timeout and the Timeline action", async () => {
    loadSeries();
    const options = { ...props(), selected: "gateway-to-middle" };
    render(<ElementResults {...options} />);
    await screen.findByRole("img", { name: /gateway-to-middle: Sent attempts/ });
    expect(row("Sent attempts").textContent).toContain("15 RPSPooled");
    expect(row("Orphaned attempts").textContent).toBe("Orphaned attempts2per replication");
    expect(row("Timeout share").textContent).toContain("25% (95% CI -10%–70%)");
    expect(row("Timeout share").querySelector(".summary-interval--unreliable")).toBeTruthy();
    expect(screen.getByText("Unreliable interval: increase Replications.")).toBeTruthy();
    expect(row("Mean call duration").textContent).toContain("22 msPooled");
    expect(row("Timeout").textContent).toContain("80 ms");
    expect(screen.getByText(/Call duration includes received responses/)).toBeTruthy();
    expect(document.querySelector('[data-threshold-ms="80"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show on Timeline" }));
    expect(options.onShowTimeline).toHaveBeenCalledOnce();
  });
  it("follows the shared cursor and shows Time sources without Summary CI", async () => {
    loadSeries();
    const options = { ...props(), selected: "gateway-to-middle", window: 1 };
    const view = render(<ElementResults {...options} />);
    await waitFor(() => expect(row("Sent attempts").textContent).toContain("40 RPSWindow 1"));
    expect(row("Timeout share").textContent).toContain("50%Window 1");
    expect(row("Admitted amplification").textContent).toContain("2.5×");
    expect(row("Admitted amplification").textContent).toContain("Approximate");
    expect(document.querySelector(".summary-interval")).toBeNull();
    expect(document.querySelector('[data-cursor-window="1"]')).toBeTruthy();
    view.rerender(<ElementResults {...options} window={2} />);
    expect(document.querySelector('[data-cursor-window="1"]')).toBeNull();
    expect(document.querySelector('[data-cursor-window="2"]')).toBeTruthy();
  });
  it("offers a selection hint and never loads or borrows an unavailable element", () => {
    loadSeries();
    const options = props();
    const view = render(<ElementResults {...options} selected={null} />);
    expect(screen.getByText(/Select a node or connection/)).toBeTruthy();
    view.rerender(<ElementResults {...options} selected="new-service" />);
    expect(screen.getByText(/No results for this element/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(seriesLoader.load).not.toHaveBeenCalled();
    expect(seriesLoader.loadConnections).not.toHaveBeenCalled();
  });
  it("hides the previous replication latency while the selected replication loads", async () => {
    loadSeries();
    let complete!: (nodes: typeof decodedNodes) => void;
    const pending = new Promise<typeof decodedNodes>(resolve => { complete = resolve; });
    vi.mocked(seriesLoader.load).mockResolvedValueOnce(decodedNodes).mockReturnValueOnce(pending);
    const options = props();
    const view = render(<ElementResults {...options} />);
    await waitFor(() => expect(row("Mean latency").textContent).toContain("21 ms"));
    view.rerender(<ElementResults {...options} replication={1} />);
    expect(row("Mean latency").textContent).toContain("n/a");
    expect(screen.getByText("Loading element series…")).toBeTruthy();
    const next = decodedNodes.map(node => ({ ...node, latency: [
      { count: 1, sumMs: 999 }, { count: 1, sumMs: 50 }, { count: 9, sumMs: 450 },
    ] }));
    await act(async () => complete(next));
    await waitFor(() => expect(row("Mean latency").textContent).toContain("50 ms"));
    expect(row("Mean latency").textContent).toContain("Replication 1");
  });
  it("discloses the available range when a service latency window crosses warmup", async () => {
    loadSeries();
    const options = props();
    options.manifest.series!.warmupMs = 150;
    render(<ElementResults {...options} />);
    expect(await screen.findByText("Latency covers 200 ms–350 ms; samples in the window crossing warmup cannot be separated.")).toBeTruthy();
    await waitFor(() => expect(row("Mean latency").textContent).toContain("20 ms"));
  });
});
