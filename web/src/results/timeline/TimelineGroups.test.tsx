import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Catalog } from "../../api/apiTypes";
import fullCatalog from "../../test/catalog.json";
import { manifest } from "../../test/fixtures";
import { replicaFixture } from "../../test/replicaResults";
import { recordedWindow } from "../../test/series";
import { seriesLoader } from "../series";
import { Timeline } from "./Timeline";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(connection = false) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const { run, runModel, runExperiment } = replicaFixture();
  const id = connection ? "gateway-to-middle" : "gateway";
  if (connection) {
    runModel.connections.find(item => item.id === id)!.params.pool = { capacity: 1, queueCapacity: 4, acquireTimeout: "50ms" };
    run.variants[0].points[0].aggregate.groups.push({ id, kind: "CONNECTION",
      instances: [1, 2, 3].map(replica => ({ id: `${id}#${replica}`, replica })) });
  }
  const extrema = { minUtilization: 0.02, maxUtilization: 0.97, maxUtilizationReplica: 2,
    minMeanQueueLength: 0.1, maxMeanQueueLength: 0.4, maxMeanQueueLengthReplica: 2 };
  const window = (replica: boolean) => recordedWindow({ durationMs: 100, entries: { total: { originalArrivals: 10 } },
    slotPools: { [connection ? "pool" : "handlers"]: { busyIntegralMs: replica ? 97 : 102,
      capacityIntegralMs: replica ? 100 : 300, queueIntegralMs: replica ? 40 : 60,
      waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0,
      ...(replica ? {} : { replicaExtrema: extrema }) } } });
  const nodes = [id, `${id}#2`].map((id, index) => ({ id, windows: [window(index > 0)] }));
  const connections = nodes.map(node => ({ id: node.id, windows: node.windows.map(window => ({
    clientOriginalArrivals: 0, failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
    startMs: window.startMs, durationMs: window.durationMs, sentAttempts: 10, succeeded: 10, failed: 0,
    retries: 0, timeouts: 0, orphaned: 0, inFlightIntegralMs: 20, orphanedIntegralMs: 0,
    backoffIntegralMs: 0, latency: window.latency, slotPools: window.slotPools,
  })) }));
  const load = vi.spyOn(seriesLoader, "load").mockImplementation(async request =>
    connection ? [] : nodes.filter(node => request.nodes.includes(node.id)));
  const loadConnections = vi.spyOn(seriesLoader, "loadConnections").mockImplementation(async request =>
    connection ? connections.filter(item => request.connections.includes(item.id)) : []);
  const props = { runId: "groups", summary: run, model: runModel, experiment: runExperiment,
    catalog: fullCatalog as Catalog, manifest: { ...manifest, series: { ...manifest.series!, warmupMs: 0, measurementMs: 100, windowMs: 100 } },
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 0, selectedNodes: [id] };
  return { id, props, load, loadConnections, nodes };
}

it.each([false, true])("shows group min–max and adds only the chosen replica (connection: %s)", async connection => {
  const { id, props, load, loadConnections } = setup(connection);
  render(<Timeline {...props} />);
  const title = connection ? "Pool utilization" : "Utilization";
  await screen.findByRole("region", { name: title });
  const utilization = () => within(screen.getByRole("region", { name: title }));
  expect(utilization().getByText("34%")).toBeTruthy();
  expect(utilization().getByText("Replica range: 2%–97%")).toBeTruthy();
  const queue = screen.getByRole("region", { name: connection ? "Connection pool" : "Queue" });
  expect(within(queue).getByText("Replica range: 0.1 requests–0.4 requests")).toBeTruthy();
  const requested = () => connection ? loadConnections.mock.calls.flatMap(([request]) => request.connections)
    : load.mock.calls.flatMap(([request]) => request.nodes);
  expect(requested()).toEqual([id]);
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Add replica #2 to chart" }));
  await waitFor(() => expect(utilization().getByText("97%")).toBeTruthy());
  expect(utilization().getByText(`${id}#2 · ${connection ? "Connection pool utilization" : "Handler utilization"} · Baseline`)).toBeTruthy();
  expect(requested()).toContain(`${id}#2`);
  expect(requested()).not.toContain(`${id}#1`);
  expect(requested()).not.toContain(`${id}#3`);
  expect(utilization().getAllByText(/Replica range:/)).toHaveLength(1);
  fireEvent.click(screen.getByRole("checkbox", { name: "Add replica #2 to chart" }));
  await waitFor(() => expect(utilization().queryByText("97%")).toBeNull());
});

it("selects a replica from the canvas, keeps the group and shares its pinned cursor", async () => {
  const { props } = setup();
  const onCursorChange = vi.fn();
  const view = render(<Timeline {...props} selectedNodes={["gateway#2"]} onCursorChange={onCursorChange} />);
  const utilization = await screen.findByRole("region", { name: "Utilization" });
  expect(within(utilization).getByText("97%")).toBeTruthy();
  expect(within(utilization).getByText("34%")).toBeTruthy();
  fireEvent.keyDown(within(utilization).getByRole("slider"), { key: "Home" });
  expect(onCursorChange).toHaveBeenCalledWith(0);
  view.rerender(<Timeline {...props} selectedNodes={["gateway#2"]} cursorWindow={null} />);
  expect(within(utilization).queryByText("97%")).toBeNull();
  view.rerender(<Timeline {...props} runId="another-run" />);
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Utilization" })).queryByText("97%")).toBeNull());
});

it("uses each comparison's recorded bounds and keeps queue ranges when utilization is undefined", async () => {
  const { props, load, nodes } = setup();
  props.summary.variants.push({ ...structuredClone(props.summary.variants[0]), id: "other", label: "Other" });
  props.experiment.variants.push({ id: "other", label: "Other", overrides: {} });
  load.mockImplementation(async request => nodes.filter(node => request.nodes.includes(node.id)).map(node => ({
    ...node, windows: node.windows.map(window => {
      const result = structuredClone(window);
      const pool = result.slotPools.handlers;
      if (request.variant === "other") Object.assign(pool.replicaExtrema!, { minUtilization: 0.1, maxUtilization: 0.9 });
      if (request.replication === 1) {
        pool.capacityIntegralMs = 0;
        Object.assign(pool.replicaExtrema!, { minUtilization: null, maxUtilization: null, maxUtilizationReplica: null });
      }
      return result;
    }),
  })));
  const view = render(<Timeline {...props} />);
  await screen.findByText("Replica range: 2%–97%");
  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "other" } });
  await screen.findByText("Replica range: 10%–90%");
  expect(screen.getByText("Replica range: 2%–97%")).toBeTruthy();
  view.rerender(<Timeline {...props} replication={1} />);
  await waitFor(() => expect(screen.getAllByText("Replica range: —–—")).toHaveLength(2));
  expect(screen.getAllByText("Replica range: 0.1 requests–0.4 requests")).toHaveLength(2);
  expect(screen.queryByText("Replica range: 2%–97%")).toBeNull();
});

it.each([false, true])("shows a compared group's range when the primary has one instance (connection: %s)", async connection => {
  const { id, props, load, loadConnections, nodes } = setup(connection);
  props.summary.variants.push({ ...structuredClone(props.summary.variants[0]), id: "replicated", label: "Replicated" });
  props.experiment.variants.push({ id: "replicated", label: "Replicated", overrides: { "gateway.replicas": 3 } });
  props.model.blocks.gateway.params.replicas = 1;
  props.summary.variants[0].points[0].aggregate.groups = [];
  if (connection) {
    loadConnections.mockImplementation(async request => [{ id, windows: [{
      clientOriginalArrivals: 0, failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs: 0, durationMs: 100,
      sentAttempts: 10, succeeded: 10, failed: 0, retries: 0, timeouts: 0, orphaned: 0,
      inFlightIntegralMs: 20, orphanedIntegralMs: 0, backoffIntegralMs: 0, latency: nodes[0].windows[0].latency,
      slotPools: { pool: { ...nodes[0].windows[0].slotPools.pool,
        ...(request.variant === "baseline" ? { replicaExtrema: undefined } : {}) } },
    }] }]);
  } else {
    load.mockImplementation(async request => [{ id, windows: nodes[0].windows.map(window => ({ ...window,
      slotPools: { handlers: { ...window.slotPools.handlers,
        ...(request.variant === "baseline" ? { replicaExtrema: undefined } : {}) } },
    })) }]);
  }
  render(<Timeline {...props} />);
  const title = connection ? "Pool utilization" : "Utilization";
  await screen.findByRole("region", { name: title });
  expect(screen.queryByText("Replica range: 2%–97%")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "replicated" } });
  expect(await screen.findByText("Replica range: 2%–97%")).toBeTruthy();
  expect(screen.getAllByText("Replica range: 0.1 requests–0.4 requests")).toHaveLength(1);
});
