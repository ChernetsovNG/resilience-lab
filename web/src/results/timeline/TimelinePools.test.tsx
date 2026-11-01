import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Catalog } from "../../api/apiTypes";
import fullCatalog from "../../test/catalog.json";
import { experiment, manifest, model, summary } from "../../test/fixtures";
import { seriesLoader, type DecodedConnectionWindow } from "../series";
import { Timeline } from "./Timeline";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = "gateway-to-middle";
const poolMetrics = ["Connection pool utilization", "Mean connection wait queue", "Connection acquisition timeouts"];

function setup() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const window: DecodedConnectionWindow = {
    startMs: 0, durationMs: 100, clientOriginalArrivals: 0, failuresByReason: {}, circuitOpenMs: 0,
    circuitRejections: 0, retriesDenied: 0, fallbacks: 0, sentAttempts: 10, retries: 2, succeeded: 7,
    failed: 2, timeouts: 1, orphaned: 1, inFlightIntegralMs: 200, orphanedIntegralMs: 40, backoffIntegralMs: 50,
    latency: { count: 2, sumMs: 12, meanMs: 6, p50Ms: 4, p95Ms: 8, p99Ms: 8 }, slotPools: {},
  };
  vi.spyOn(seriesLoader, "load").mockResolvedValue([]);
  const load = vi.spyOn(seriesLoader, "loadConnections").mockImplementation(async request =>
    request.connections.includes(id) ? [{ id, windows: [window] }] : []);
  const props = { runId: "pool-availability", summary: structuredClone(summary), model: structuredClone(model),
    experiment: structuredClone(experiment), catalog: fullCatalog as Catalog,
    manifest: { ...manifest, series: { ...manifest.series!, warmupMs: 0, measurementMs: 100, windowMs: 100 } },
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 0, selectedNodes: [id] };
  const pooled: DecodedConnectionWindow = { ...window, slotPools: { pool: {
    busyIntegralMs: 100, capacityIntegralMs: 200, queueIntegralMs: 20, waitCount: 2,
    totalWaitMs: 10, queueFullCount: 0, waitLimitCount: 1,
  } } };
  return { props, load, window, pooled };
}

function choices() {
  return within(screen.getByRole("group", { name: "gateway → middle (gateway-to-middle) · Call" }));
}

it("omits pool charts and choices for a call without a pool while retaining retry and backoff metrics", async () => {
  const { props } = setup();
  render(<Timeline {...props} />);
  await screen.findByRole("region", { name: "Rates" });
  expect(screen.queryByRole("region", { name: "Pool utilization" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Connection pool" })).toBeNull();
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  for (const name of poolMetrics) expect(choices().queryByRole("checkbox", { name })).toBeNull();
  for (const name of ["Retries", "Timeouts", "Mean backoff"]) fireEvent.click(choices().getByRole("checkbox", { name }));
  expect(await screen.findByText("gateway → middle (gateway-to-middle) · Retries · Baseline")).toBeTruthy();
  expect(screen.getByText("gateway → middle (gateway-to-middle) · Timeouts · Baseline")).toBeTruthy();
  expect(screen.getByText("0.5 requests")).toBeTruthy();
});

it("offers and draws pool metrics only for the active comparison that enables the pool", async () => {
  const { props, load, window, pooled } = setup();
  props.experiment.variants[1].overrides[`${id}.pool`] = { size: 2 };
  load.mockImplementation(async request => [{ id, windows: [request.variant === "no-retries" ? pooled : window] }]);
  render(<Timeline {...props} />);
  await screen.findByRole("region", { name: "Rates" });
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  for (const name of poolMetrics) expect(choices().queryByRole("checkbox", { name })).toBeNull();

  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "no-retries" } });
  for (const name of poolMetrics) fireEvent.click(choices().getByRole("checkbox", { name }));
  const utilization = await screen.findByRole("region", { name: "Pool utilization" });
  await waitFor(() => expect(within(utilization).getByText("50%")).toBeTruthy());
  expect(within(utilization).getByText("gateway → middle (gateway-to-middle) · Connection pool utilization · No retries")).toBeTruthy();
  expect(within(utilization).queryByText(/Baseline/)).toBeNull();
  const queue = screen.getByRole("region", { name: "Connection pool" });
  expect(within(queue).getByText("0.2 requests")).toBeTruthy();
  expect(within(queue).getByText("1 requests")).toBeTruthy();
  expect(within(queue).queryByText(/Baseline/)).toBeNull();

  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "" } });
  expect(screen.queryByRole("region", { name: "Pool utilization" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Connection pool" })).toBeNull();
  for (const name of poolMetrics) expect(choices().queryByRole("checkbox", { name })).toBeNull();
});

it("follows the selected grid point when its override disables and restores the pool", async () => {
  const { props, load, window, pooled } = setup();
  props.model.connections.find(connection => connection.id === id)!.params.pool = { size: 2 };
  const point = structuredClone(props.summary.variants[0].points[0]);
  props.summary.variants[0].points.push({ ...point, id: "p1", coordinates: { [`${id}.pool`]: null } });
  load.mockImplementation(async request => [{ id, windows: [request.cell === "p1" ? window : pooled] }]);
  const view = render(<Timeline {...props} />);
  await screen.findByRole("region", { name: "Pool utilization" });
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  expect(choices().getByRole("checkbox", { name: poolMetrics[0], checked: true })).toBeTruthy();

  view.rerender(<Timeline {...props} pointId="p1" />);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Pool utilization" })).toBeNull());
  expect(screen.queryByRole("region", { name: "Connection pool" })).toBeNull();
  for (const name of poolMetrics) expect(choices().queryByRole("checkbox", { name })).toBeNull();
  expect(screen.getByRole("region", { name: "Rates" })).toBeTruthy();

  view.rerender(<Timeline {...props} />);
  expect(await screen.findByRole("region", { name: "Pool utilization" })).toBeTruthy();
  expect(choices().getByRole("checkbox", { name: poolMetrics[0], checked: true })).toBeTruthy();
});
