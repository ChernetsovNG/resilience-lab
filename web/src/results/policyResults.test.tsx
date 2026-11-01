import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Catalog } from "../api/apiTypes";
import fullCatalog from "../test/catalog.json";
import { manifest } from "../test/fixtures";
import { replicaFixture } from "../test/replicaResults";
import { ReplicaResults } from "../inspector/ReplicaResults";
import { ElementResults } from "../inspector/ElementResults";
import { projectElementResults } from "../inspector/elementResultsData";
import { entryModels } from "./entries";
import { seriesLoader } from "./series";
import { recordedWindow } from "../test/series";
import { policyOutputAvailable } from "../workspace/policyParameters";

const catalog = fullCatalog as Catalog;
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const { run, runModel, runExperiment } = replicaFixture();
  const context = { summary: run, manifest, runModel, currentModel: runModel, experiment: runExperiment, catalog,
    variantId: "baseline", pointId: "p0", replication: 0, window: null, selected: "gateway" };
  return { run, runModel, runExperiment, context };
}

it("shows the client's fallback output from the selected completion window", async () => {
  const { context, runModel } = fixture();
  const entries = context.summary.variants[0].points[0].aggregate.entries;
  entries.clients.client = structuredClone(entries.total);
  runModel.connections.find(connection => connection.id === "gateway-to-middle")!.params.fallback = { on: ["timeout"] };
  vi.spyOn(seriesLoader, "load").mockResolvedValue([{ id: "client", windows: [recordedWindow({ degraded: 4, durationMs: 100 })] }]);
  vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue([]);
  render(<ElementResults {...context} runId="client-fallback" selected="client" window={0} onShowTimeline={() => undefined} />);
  await waitFor(() => expect(screen.getByRole("rowheader", { name: "Successful requests with fallback" }).closest("tr")!.textContent).toContain("40 RPS"));
});

it("does not apply a policy from a variant where the selected replica does not exist", () => {
  const { runModel } = fixture();
  const smaller = structuredClone(runModel);
  smaller.blocks.gateway.params.replicas = 1;
  smaller.blocks.gateway.params.healthCheck = {};
  smaller.connections.find(connection => connection.id === "gateway-to-middle")!.params.circuitBreaker = {};
  expect(policyOutputAvailable("notReadyShare", "gateway", [runModel, smaller], 2)).toBe(false);
  expect(policyOutputAvailable("notReadyShare", "gateway", [runModel, smaller], 1)).toBe(true);
  expect(policyOutputAvailable("circuitOpenShare", "gateway-to-middle", [runModel, smaller], 2)).toBe(false);
});

it("shows a policy enabled only in another run variant, using the selected row's saved totals", () => {
  const { context, run, runExperiment } = fixture();
  run.variants.push({ ...structuredClone(run.variants[0]), id: "limited", label: "Limited" });
  runExperiment.variants.push({ id: "limited", label: "Limited", overrides: { "gateway.rateLimit": { rate: "10/s", burst: 2 } } });
  Object.assign(run.variants[0].points[0].aggregate.services["gateway#2"].totals, { rateLimited: 52, offeredAttempts: 260 });
  const result = projectElementResults({ ...context, selected: "gateway#2" })!;
  expect(result.values.rateLimitedRate?.value).toBe(0.2);
  expect(result.values.notReadyShare).toBeUndefined();
  expect(result.values.ejectedShare).toBeUndefined();
});

it("hides all policy outputs without policies and respects an individual replica's disabled health check", () => {
  const { context, runModel } = fixture();
  const policies = ["rateLimitedRate", "notReadyShare", "ejectedShare"];
  expect(projectElementResults(context)!.outputs.filter(output => policies.includes(output.id))).toEqual([]);
  runModel.blocks.gateway.params.healthCheck = { interval: "100ms" };
  runModel.blocks.gateway.replicaOverrides!["2"].healthCheck = null;
  expect(projectElementResults(context)!.values.notReadyShare?.value).toBe(0);
  expect(projectElementResults({ ...context, selected: "gateway#2" })!.values.notReadyShare).toBeUndefined();
  expect(projectElementResults({ ...context, selected: "gateway#1" })!.values.notReadyShare?.value).toBe(0);
});

it("shows call policy outputs only for the policies present in the run", () => {
  const { context, runModel, run } = fixture();
  const connection = runModel.connections.find(connection => connection.id === "gateway-to-middle")!;
  connection.params.circuitBreaker = { failureThreshold: 1 };
  connection.params.retryBudget = { ratio: 0.1 };
  connection.params.fallback = { on: ["timeout"] };
  run.variants[0].points[0].aggregate.connections[connection.id] = { slotPoolSummaries: {}, totals: {
    circuitOpenMs: 800, circuitRejections: 4, retriesDenied: 2, fallbacks: 6, measurementMs: 2000,
    sentAttempts: 20, retries: 0, succeeded: 10, failed: 10, timeouts: 10, orphaned: 0,
    inFlightIntegralMs: 0, orphanedIntegralMs: 0, backoffIntegralMs: 0, failuresByReason: {}, slotPools: {},
  } };
  const result = projectElementResults({ ...context, selected: connection.id })!;
  expect(result.values.circuitOpenShare?.value).toBe(0.4);
  expect(result.values.circuitRejectionsPerSecond?.value).toBe(2);
  expect(result.values.retriesDeniedPerSecond?.value).toBe(1);
  expect(result.values.fallbacksPerSecond?.value).toBe(3);
  delete connection.params.circuitBreaker;
  expect(projectElementResults({ ...context, selected: connection.id })!.values.circuitOpenShare).toBeUndefined();
});

it("adds and sorts policy columns, including call outlier detection and a single-replica override", () => {
  const { run, runModel, runExperiment } = fixture();
  const aggregate = run.variants[0].points[0].aggregate, group = aggregate.groups[0];
  const view = render(<ReplicaResults group={group} aggregate={aggregate} catalog={catalog} replications={2}
    models={[runModel]} selected={null} />);
  const table = screen.getByRole("table", { name: "Replicas · gateway" });
  expect(within(table).queryByRole("button", { name: "Ejected" })).toBeNull();
  expect(within(table).queryByRole("button", { name: "Not ready" })).toBeNull();
  runModel.blocks.source = structuredClone(runModel.blocks.middle);
  const incoming = { id: "source-to-gateway", type: "call", from: "source", to: "gateway", params: { outlierDetection: {} } };
  runModel.connections.push(incoming);
  runModel.blocks.gateway.replicaOverrides!["2"].healthCheck = { interval: "100ms" };
  runModel.blocks.gateway.params.rateLimit = { rate: "20/s", burst: 3 };
  Object.assign(aggregate.services["gateway#2"].totals, { ejectedMs: 800, notReadyMs: 500, rateLimited: 52 });
  view.rerender(<ReplicaResults group={group} aggregate={aggregate} catalog={catalog} replications={2}
    models={entryModels(run, runModel, catalog, runExperiment.variants)} selected={null} />);
  for (const column of ["Ejected", "Not ready", "Rate-limited"]) {
    fireEvent.click(within(table).getByRole("button", { name: column }));
    expect(within(table).getAllByRole("row")[1].textContent).toContain("#2");
  }
  fireEvent.click(within(table).getByRole("button", { name: "Ejected" }));
  fireEvent.click(within(table).getByRole("button", { name: "Ejected" }));
  expect(within(table).getAllByRole("row")[1].textContent).toContain("#1");
  runModel.connections = runModel.connections.filter(connection => connection.id !== incoming.id);
  view.rerender(<ReplicaResults group={group} aggregate={aggregate} catalog={catalog} replications={2}
    models={[runModel]} selected={null} />);
  expect(within(table).queryByRole("button", { name: "Ejected" })).toBeNull();
  expect(within(table).getByRole("button", { name: "Not ready" })).toBeTruthy();
});
