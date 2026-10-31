import { recordedWindow } from "./test/series";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { slotPoolResource, documentViews, experiment, experimentPath, model, modelPath, summary } from "./test/fixtures";
import { seriesLoader } from "./results/series";
import { setupAppTests, deferred, server, open, selectGateway, editHandlers, button, editField } from "./test/app";

setupAppTests();

describe("diagram results", () => {

  it("shows summary metrics only on a variant, while toggling preserves documents and history", async () => {
    const fetchMock = server();
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect(screen.queryByRole("region", { name: "Results context" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    fireEvent.click(button("Run"));
    await screen.findByRole("table", { name: "Findings" });
    expect(screen.queryByRole("region", { name: "Results context" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    const region = screen.getByRole("region", { name: "Results context" });
    expect(region.textContent).toContain("Summary");
    const metrics = await screen.findByTestId("canvas-results-gateway");
    expect(metrics.textContent).toContain("Utilization 50%");
    expect(metrics.textContent).toContain("Mean queue 0.1");
    expect(metrics.textContent).toContain("Queue rejections 7.7%");
    expect(screen.getByTestId("canvas-edge-label-client-to-gateway").textContent).toContain("Attempts per request 1.2×");
    expect(screen.queryByTestId("canvas-results-middle")).toBeNull();
    expect(screen.queryByRole("img", { name: "First saturated node" })).toBeNull();

    const node = screen.getByTestId("rf__node-gateway").querySelector<HTMLElement>(".block-node")!;
    expect(node.style.backgroundColor).not.toBe("");
    fireEvent.change(screen.getByLabelText("Node overlay"), { target: { value: "off" } });
    expect(screen.queryByTestId("canvas-results-gateway")).toBeNull();
    expect(node.style.backgroundColor).toBe("");
    expect(button("Save").disabled).toBe(true);
    expect(button("Undo").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Node overlay"), { target: { value: "utilization" } });
    expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("50%");
    await selectGateway();
    editHandlers("6");
    expect(within(region).getByText("Results belong to a previous document version.")).toBeTruthy();
    expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("50%");
    fireEvent.click(button("Undo"));
    expect(within(region).queryByText("Results belong to a previous document version.")).toBeNull();
    expect(screen.getByTestId("canvas-param-gateway-handlers").textContent).toBe("4");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    expect(screen.queryByRole("region", { name: "Results context" })).toBeNull();
    expect(screen.queryByTestId("canvas-results-gateway")).toBeNull();
  });

  it("shares the selected grid point, follows variants and takes the badge from the summary", async () => {
    const run = structuredClone(summary);
    run.grid = [{ path: "gateway.handlers", values: [4, 6] }];
    const second = structuredClone(run.variants[0].points[0]);
    second.id = "p1";
    second.coordinates = { "gateway.handlers": 6 };
    second.aggregate.services.gateway.totals.slotPools.handlers.busyIntegralMs = 1500;
    second.saturation.firstNodes = [
      { node: "gateway", ...slotPoolResource("gateway"), replicationCount: 1, medianStartMs: 200, minStartMs: 200, maxStartMs: 200 },
    ];
    run.variants[0].points.push(second);
    const alternative = structuredClone(second);
    alternative.aggregate.services.gateway.totals.slotPools.handlers.busyIntegralMs = 500;
    alternative.saturation.firstNodes = [];
    run.variants[1].points.push(alternative);
    server((url) => url.endsWith("/summary") ? { body: run } : undefined);
    await open();
    fireEvent.click(button("Run"));
    await screen.findByRole("table", { name: "Findings" });
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    fireEvent.change(screen.getByLabelText("Grid point"), { target: { value: "p1" } });
    expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("75%");
    expect(screen.getByRole("img", { name: "First saturated node" }).title).toBe("1 of 2 replications");
    const insight = screen.getByRole("region", { name: "Saturation insight" });
    expect(within(insight).getByRole("heading").textContent).toContain("Baseline · Handlers · gateway = 6");
    expect(insight.textContent).toContain("gateway first in 1 of 2 replications");
    fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
    expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("25%");
    expect(screen.queryByRole("img", { name: "First saturated node" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Grid point"), { target: { value: "p0" } });
    expect(screen.queryByTestId("canvas-results-gateway")).toBeNull();
  });

});

it("colors nodes and labels the scale for the selected overlay metric", async () => {
  server();
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  const node = screen.getByTestId("rf__node-gateway").querySelector<HTMLElement>(".block-node")!;
  const utilization = node.style.backgroundColor;
  const overlay = screen.getByLabelText("Node overlay");
  fireEvent.change(overlay, { target: { value: "meanQueue" } });
  expect(node.style.backgroundColor).not.toBe(utilization);
  expect(screen.getByLabelText("Node color scale").textContent).toContain("Queue fill: 0%–100%");
  const queue = node.style.backgroundColor;
  fireEvent.change(overlay, { target: { value: "queueRejections" } });
  expect(node.style.backgroundColor).not.toBe(queue);
  expect(screen.getByLabelText("Node color scale").textContent).toContain("Queue rejections: 0%–100%");
  fireEvent.change(overlay, { target: { value: "off" } });
  expect(screen.queryByLabelText("Node color scale")).toBeNull();
  expect(screen.queryByTestId("canvas-edge-label-client-to-gateway")).toBeNull();
  expect(node.style.backgroundColor).toBe("");
});

it("shares point, replication and time between the context row, Findings, Timeline and canvas", async () => {
  const run = structuredClone(summary);
  run.grid = [{ path: "gateway.handlers", values: [4, 1000] }];
  const point = structuredClone(run.variants[0].points[0]);
  point.id = "p1";
  point.coordinates = { "gateway.handlers": 1000 };
  point.aggregate.services.gateway.totals.slotPools.handlers.busyIntegralMs = 1500;
  run.variants[0].points.push(point);
  run.variants[1].points.push({ ...point, id: "p2", coordinates: { "gateway.handlers": 6 } });
  vi.spyOn(seriesLoader, "load").mockImplementation(async ({ nodes, fromWindow = 0, untilWindow, replication, cell }) => nodes.map(id => ({
    id, windows: Array.from({ length: untilWindow - fromWindow }, (_, index) => recordedWindow({ startMs: (fromWindow + index) * 10,
      durationMs: 10,
      originalArrivals: 1,
      offeredAttempts: 2,
      admittedAttempts: 1.5,
      successes: 1,
      latency: { count: 1, sumMs: 5, meanMs: 5, p50Ms: 5, p95Ms: 7, p99Ms: 9 },
      client: { originalArrivals: 1 },
      slotPools: { handlers: { busyIntegralMs: cell === "p1" && replication === 1 ? 8 : 2, queueIntegralMs: replication === 1 ? 30 : 70, capacityIntegralMs: 10, waitCount: 0, totalWaitMs: 0, queueFullCount: 0.5, waitLimitCount: 0 } } })),
  })));
  server(url => url.endsWith("/summary") ? { body: run } : undefined);
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  expect(screen.queryByLabelText("Grid point")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  const row = screen.getByRole("region", { name: "Results context" });
  fireEvent.pointerDown(row);
  const pointSelect = within(row).getByLabelText("Grid point");
  expect(within(pointSelect).getByRole("option", { name: "Handlers · gateway = 1,000" })).toBeTruthy();
  expect(within(pointSelect).getByRole("option", { name: "Handlers · gateway = 6" })).toBeTruthy();
  fireEvent.change(pointSelect, { target: { value: "p1" } });
  expect((within(row).getByLabelText("Replication") as HTMLSelectElement).disabled).toBe(false);
  expect(screen.getByRole("region", { name: "Saturation insight" }).textContent).toContain("Baseline · Handlers · gateway = 1,000");
  expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("75%");
  fireEvent.click(within(row).getByRole("button", { name: "Time" }));
  expect((within(row).getByLabelText("Replication") as HTMLSelectElement).disabled).toBe(false);
  fireEvent.change(within(row).getByLabelText("Replication"), { target: { value: "1" } });
  await waitFor(() => expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("80%"));
  await selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  const timeline = await screen.findByTestId("timeline-cursor");
  expect(timeline.textContent).toContain("replication 1");
  expect(timeline.textContent).toContain("Window 0");
  expect(screen.getAllByLabelText("Replication")).toHaveLength(1);
  expect(screen.getAllByLabelText("Grid point")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Clear time cursor" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Return to summary" })).toBeNull();
  const chartCursor = within(await screen.findByRole("region", { name: "Queue" })).getByRole("slider");
  fireEvent.keyDown(chartCursor, { key: "Escape" });
  expect(within(row).getByRole("button", { name: "Time" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(row).getByRole("button", { name: "Summary" }));
  expect(timeline.textContent).toContain("Hover to inspect windows");
  expect(screen.queryByRole("slider", { name: "Playback window" })).toBeNull();
  expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("75%");
  fireEvent.change(within(row).getByLabelText("Replication"), { target: { value: "0" } });
  expect(within(row).getByRole("button", { name: "Summary" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("75%");
  const summaryChartCursor = within(await screen.findByRole("region", { name: "Queue" })).getByRole("slider");
  vi.spyOn(summaryChartCursor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  fireEvent(summaryChartCursor, new MouseEvent("pointermove", { bubbles: true, clientX: 50 }));
  expect(timeline.textContent).toContain("Window 55");
  expect(timeline.textContent).toContain("replication 0");
  await waitFor(() => expect(screen.getByRole("region", { name: "Queue" }).querySelector("dd")!.textContent!.trim()).toBe("7 requests"));
  fireEvent.click(within(row).getByRole("button", { name: "Time" }));
  expect(timeline.textContent).toContain("Window 0");
  fireEvent.click(within(row).getByRole("button", { name: "Summary" }));
  expect(timeline.textContent).toContain("Hover to inspect windows");
  fireEvent.click(within(row).getByRole("button", { name: "Time" }));
  fireEvent.keyDown(screen.getByTestId("rf__node-gateway"), { key: "Escape" });
  expect(within(row).getByRole("button", { name: "Summary" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect(screen.queryByRole("region", { name: "Results context" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  expect(screen.getByRole("region", { name: "Saturation insight" }).textContent).toContain("Baseline · Handlers · gateway = 1,000");
  expect(button("Save").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(true);
});

it("reserves empty metric rows without borrowing pooled values while a Time frame loads or fails", async () => {
  const gate = deferred();
  vi.spyOn(seriesLoader, "load").mockImplementation(async () => {
    await gate.promise;
    throw new Error("Series unavailable");
  });
  server();
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("50%");
  fireEvent.click(button("Time"));
  expect(screen.getByTestId("canvas-results-gateway").classList.contains("canvas-metrics--empty")).toBe(true);
  expect(screen.getByTestId("canvas-results-gateway").textContent).not.toContain("50%");
  expect(screen.getByTestId("canvas-edge-label-client-to-gateway").querySelector(".canvas-metrics--empty")).toBeTruthy();
  await act(async () => gate.release());
  await screen.findByText("Series unavailable");
  expect(screen.getByTestId("canvas-results-gateway").classList.contains("canvas-metrics--empty")).toBe(true);
  expect(screen.getByTestId("canvas-results-gateway").textContent).not.toContain("50%");
  expect(screen.getByTestId("canvas-edge-label-client-to-gateway").querySelector(".canvas-metrics--empty")).toBeTruthy();
  fireEvent.click(button("Summary"));
  expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("50%");
});

it("compares queue fill across nodes and windows using immutable variant and grid capacities", async () => {
  const runModel = structuredClone(model);
  runModel.blocks.gateway.params.queue = 64;
  runModel.blocks.middle.params.queue = 8;
  const runExperiment = structuredClone(experiment);
  runExperiment.variants[0].overrides = { "gateway.queue": 32 };
  const run = structuredClone(summary);
  run.grid = [{ path: "gateway.queue", values: [16, 8, 0] }];
  const point = run.variants[0].points[0];
  point.coordinates = { "gateway.queue": 16 };
  point.aggregate.services.gateway.totals.slotPools.handlers.queueIntegralMs = 16000;
  point.aggregate.services.middle = structuredClone(point.aggregate.services.gateway);
  point.aggregate.services.middle.totals.slotPools.handlers.queueIntegralMs = 8000;
  run.variants[0].points.push({ ...point, id: "p1", coordinates: { "gateway.queue": 8 } });
  run.variants[0].points.push({ ...point, id: "p2", coordinates: { "gateway.queue": 0 } });
  vi.spyOn(seriesLoader, "load").mockImplementation(async ({ nodes, fromWindow = 0, untilWindow, cell }) => nodes.map(id => ({
    id, windows: Array.from({ length: untilWindow - fromWindow }, (_, index) => recordedWindow({ startMs: (fromWindow + index) * 10,
      durationMs: 10,
      originalArrivals: 1,
      offeredAttempts: 1,
      admittedAttempts: 1,
      successes: 1,
      latency: { count: 1, sumMs: 5, meanMs: 5, p50Ms: 5, p95Ms: 7, p99Ms: 9 },
      client: { originalArrivals: 1 },
      slotPools: { handlers: { busyIntegralMs: 5, queueIntegralMs: cell === "p2" && id === "gateway" ? 0
        : (id === "gateway" ? 80 : 40) / ((fromWindow + index) === 0 ? 1 : 2), capacityIntegralMs: 10, waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } })),
  })));
  server(url => {
    if (url.endsWith("/summary")) return { body: run };
    if (url.startsWith("/api/v1/workspace/document?")) {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      if (path === modelPath) return { body: { ...documentViews[modelPath], content: { model: runModel } } };
      if (path === experimentPath) return { body: { ...documentViews[experimentPath], content: { experiment: runExperiment } } };
    }
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.change(screen.getByLabelText("Node overlay"), { target: { value: "meanQueue" } });
  const color = (id: string) => screen.getByTestId(`rf__node-${id}`).querySelector<HTMLElement>(".block-node")!.style.backgroundColor;
  expect(color("gateway")).not.toBe("");
  expect(color("gateway")).toBe(color("middle"));
  const halfFull = color("gateway");
  const legend = screen.getByLabelText("Node color scale");
  expect(legend.textContent).toBe("Queue fill: 0%–100%");
  fireEvent.click(button("Time"));
  await waitFor(() => expect(screen.getByTestId("canvas-results-gateway").getAttribute("aria-busy")).toBeNull());
  expect(color("gateway")).toBe(halfFull);
  fireEvent.click(button("Next window"));
  await waitFor(() => expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("Mean queue 4"));
  expect(color("gateway")).not.toBe(halfFull);
  expect(color("gateway")).toBe(color("middle"));
  expect(legend.textContent).toBe("Queue fill: 0%–100%");
  fireEvent.change(screen.getByLabelText("Grid point"), { target: { value: "p1" } });
  await waitFor(() => expect(screen.getByTestId("canvas-results-gateway").getAttribute("aria-busy")).toBeNull());
  expect(color("gateway")).toBe(halfFull);
  await selectGateway();
  editField("Queue capacity", "128");
  expect(color("gateway")).toBe(halfFull);
  fireEvent.change(screen.getByLabelText("Grid point"), { target: { value: "p2" } });
  await waitFor(() => expect(screen.getByTestId("canvas-results-gateway").getAttribute("aria-busy")).toBeNull());
  expect(color("gateway")).toBe("");
});
