import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import { localizeCatalog } from "../i18n/catalog";
import fullCatalog from "../test/catalog.json";
import type { Catalog } from "../api/apiTypes";
import { replicaFixture } from "../test/replicaResults";
import { recordedWindow } from "../test/series";
import { layout } from "../test/fixtures";
import { mockReactFlowDom } from "../test/reactFlow";
import { Canvas } from "../canvas/Canvas";
import { canvasResults, windowCanvasResults } from "./canvasResults";
import { usePlayback } from "./playback/usePlayback";
import type { DecodedConnection, SeriesLoadRequest } from "./series";

beforeAll(mockReactFlowDom);
const catalog = localizeCatalog(fullCatalog as Catalog);

function fixture() {
  const { run, runModel } = replicaFixture();
  runModel.blocks.gateway.params.healthCheck = {};
  const call = runModel.connections.find(edge => edge.id === "gateway-to-middle")!;
  call.params.circuitBreaker = {};
  run.variants[0].points[0].aggregate.connections[call.id] = { slotPoolSummaries: {}, totals: {
    measurementMs: 100, sentAttempts: 0, retries: 0, succeeded: 0, failed: 0, timeouts: 0, orphaned: 0,
    inFlightIntegralMs: 0, orphanedIntegralMs: 0, backoffIntegralMs: 0, failuresByReason: {},
    circuitOpenMs: 120, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, slotPools: {},
  } };
  const summary = canvasResults(run, runModel, "baseline", "p0", catalog)!;
  const nodes = [...summary.services.keys()].map(id => ({ id, windows: [recordedWindow({ notReadyMs: id === "gateway" ? 90 : 0 })] }));
  nodes.push(...[1, 2, 3].map(replica => ({ id: `gateway#${replica}`, windows: [recordedWindow({
    ejectedMs: replica === 2 ? 60 : 0, notReadyMs: replica === 2 ? 90 : 0,
  })] })));
  const connections: DecodedConnection[] = [{ id: call.id, windows: [{ startMs: 0, durationMs: 100,
    clientOriginalArrivals: 0, sentAttempts: 0, retries: 0, succeeded: 0, failed: 0, timeouts: 0, orphaned: 0,
    inFlightIntegralMs: 0, orphanedIntegralMs: 0, backoffIntegralMs: 0, failuresByReason: {},
    circuitOpenMs: 120, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, slotPools: {},
    latency: { count: 0, sumMs: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
  }] }];
  return { summary, nodes, connections, runModel };
}

it("normalizes breaker windows by caller replicas and preserves each instance's exclusion state", () => {
  const { summary, nodes, connections } = fixture();
  const frame = windowCanvasResults(summary, nodes, 0, 0, connections)!;
  expect(frame.connections.get("gateway-to-middle")?.policyState?.circuitOpenShare).toBe(0.4);
  expect(frame.services.get("gateway")?.policyState?.notReadyShare).toBe(0.3);
  expect(frame.services.get("gateway")?.instances?.map(instance => [instance.replica, instance.policyState?.ejectedShare]))
    .toEqual([[1, 0], [2, 0.6], [3, 0]]);
  expect(summary.connections.get("gateway-to-middle")?.policyState).toBeUndefined();
  expect(summary.services.get("gateway")?.policyState).toBeUndefined();
  expect(windowCanvasResults(summary, nodes.filter(node => node.id !== "gateway#2"), 0, 0, connections)).toBeNull();
});

it("loads individual replica windows before presenting a policy playback frame", async () => {
  const { summary, nodes, connections } = fixture();
  const loader = {
    load: async (request: SeriesLoadRequest) => nodes.filter(node => request.nodes.includes(node.id)),
    loadConnections: async () => connections,
  };
  const { result } = renderHook(() => usePlayback({ runId: "run", variant: "baseline", pointId: "p0", replication: 0,
    window: 0, windowCount: 1, nodes: [...summary.services.keys()], results: summary, onWindowChange: vi.fn(),
  }, loader));
  await waitFor(() => expect(result.current.frame?.services.get("gateway")?.instances?.[1].policyState?.ejectedShare).toBe(0.6));
  expect(result.current.problem).toBeNull();
});

it("marks an open breaker and the excluded replica, then clears all state in summary mode", async () => {
  const { summary, nodes, connections, runModel } = fixture();
  const frame = windowCanvasResults(summary, nodes, 0, 0, connections)!;
  const props = { model: runModel, catalog, layout, selected: [], onSelect: vi.fn(), onCommand: vi.fn() };
  const { container, rerender } = render(<Canvas {...props} results={frame} />);
  const badges = await screen.findByTestId("canvas-policies-gateway-to-middle");
  expect(within(badges).getByRole("button", { name: "Circuit breaker" }).classList.contains("policy-badge--active")).toBe(true);
  expect(within(badges).getByRole("button", { name: "Circuit breaker" }).title).toContain("40%");
  expect(container.querySelector('[data-id="gateway-to-middle"] .react-flow__edge-path')?.getAttribute("style")).toContain("stroke-dasharray");
  const group = screen.getByTestId("rf__node-gateway");
  expect(group.querySelector('[data-replicas="2"]')?.classList.contains("policy-replica--inactive")).toBe(true);
  expect(group.querySelector('[data-replicas="1"]')?.classList.contains("policy-replica--inactive")).toBe(false);
  rerender(<Canvas {...props} results={summary} />);
  expect(within(badges).getByRole("button", { name: "Circuit breaker" }).classList.contains("policy-badge--active")).toBe(false);
  expect(group.querySelector(".policy-replica--inactive")).toBeNull();
});

it("dims a single unready service only for a recorded window", async () => {
  const { summary, nodes, connections, runModel } = fixture();
  runModel.blocks.gateway.params.replicas = 1;
  const service = summary.services.get("gateway")!;
  delete service.instances;
  service.params.replicas = 1;
  const frame = windowCanvasResults(summary, nodes, 0, 0, connections)!;
  render(<Canvas model={runModel} catalog={catalog} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} results={frame} />);
  expect((await screen.findByTestId("rf__node-gateway")).querySelector(".block-shape--inactive")).not.toBeNull();
});
