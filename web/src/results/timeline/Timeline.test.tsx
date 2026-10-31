import { recordedWindow } from "../../test/series";
import { localizeCatalog } from "../../i18n/catalog";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, experiment, manifest, model, summary } from "../../test/fixtures";
import { Timeline } from "./Timeline";
import { seriesLoader, type DecodedConnection, type NodeSeriesMetrics } from "../series";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function stubSeries() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const nodes: NodeSeriesMetrics[] = [{ id: "gateway", windows: [0, 10, 20].map(startMs => recordedWindow({ startMs,
      durationMs: startMs === 20 ? 5 : 10,
      offeredAttempts: 5,
      admittedAttempts: 4,
      successes: 3,
      failures: 1,
      timeouts: 1,
      retries: 2,
      latency: { count: 1, sumMs: 10, meanMs: 10, p50Ms: 8, p95Ms: 20, p99Ms: 25 },
      entries: { total: { originalArrivals: 4 / 1.2 } },
      slotPools: { handlers: { busyIntegralMs: 7.5, queueIntegralMs: 10, capacityIntegralMs: 0, waitCount: 0, totalWaitMs: 0, queueFullCount: 1, waitLimitCount: 0 } } })) }];
  const connections: DecodedConnection[] = [{ id: "gateway-to-middle", windows: [0, 10, 20].map((startMs) => ({
    clientOriginalArrivals: 0, failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: startMs === 20 ? 5 : 10,
      sentAttempts: startMs === 20 ? 0 : 3,
      retries: 1,
      succeeded: 1,
      failed: 1,
      timeouts: 1,
      orphaned: 1,
      inFlightIntegralMs: 20,
      orphanedIntegralMs: 4,
      backoffIntegralMs: 5,
      latency: { count: 2, sumMs: 12, meanMs: 6, p50Ms: 4, p95Ms: 8, p99Ms: 8 },
      slotPools: {  } })) }];
  vi.spyOn(seriesLoader, "load").mockImplementation(async (request) => nodes.filter((node) => request.nodes.includes(node.id)));
  vi.spyOn(seriesLoader, "loadConnections").mockImplementation(async (request) => connections.filter((connection) => request.connections.includes(connection.id)));
}

const shortManifest = { ...manifest, series: { ...manifest.series!, warmupMs: 10, measurementMs: 15 } };

it("names unlabeled stored variants in comparison choices, legends and chart labels", async () => {
  stubSeries();
  const run = structuredClone(summary);
  run.variants[0].label = "baseline";
  run.variants[1].id = "variant-2";
  run.variants[1].label = "variant-2";
  render(<Timeline runId="names" summary={run} manifest={shortManifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={null} selectedNodes={["gateway"]} />);
  const compare = screen.getByRole("combobox", { name: "Compare variant" });
  expect(within(compare).getByRole("option", { name: "Variant 2" })).toBeTruthy();
  fireEvent.change(compare, { target: { value: "variant-2" } });
  expect(await screen.findByRole("region", { name: "Utilization" })).toBeTruthy();
  expect(screen.getByText("Solid: Baseline · dashed: Variant 2")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Utilization" }).textContent).not.toMatch(/variant-2|\(baseline\)/);
});

it("keeps selected metrics and their charts when catalog labels change language", async () => {
  stubSeries();
  const props = { runId: "language", summary, manifest: shortManifest, model, experiment,
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 0, selectedNodes: ["gateway"] };
  const view = render(<Timeline {...props} catalog={localizeCatalog(catalog, "ru")} />);
  await screen.findByRole("region", { name: "Загрузка" });
  view.rerender(<Timeline {...props} catalog={localizeCatalog(catalog, "en")} />);
  expect(screen.getByRole("region", { name: "Utilization" })).toBeTruthy();
});


it("does not substitute another variant when the selected variant is absent from the run", () => {
  render(<Timeline runId="run-1" summary={summary} manifest={manifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="new-variant" pointId="p0" replication={0} cursorWindow={null} selectedNodes={[]} />);
  expect(screen.getByText("The selected variant is not available in this run.")).toBeTruthy();
  expect(screen.queryByText("Baseline")).toBeNull();
});

it("shows a selected call's own rates, waiting state and response latency", async () => {
  stubSeries();
  render(<Timeline runId="run-call" summary={summary} manifest={shortManifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={1} selectedNodes={["gateway-to-middle"]} />);

  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  const choices = within(screen.getByRole("group", { name: "gateway-to-middle · Call" }));
  for (const name of ["Retries", "Successes", "Timeouts", "Mean orphaned work", "Mean backoff", "p95 latency", "p99 latency"]) {
    fireEvent.click(choices.getByRole("checkbox", { name }));
  }

  const rates = await screen.findByRole("region", { name: "Rates" });
  expect(within(rates).getByText("gateway-to-middle · Sent attempts · Baseline")).toBeTruthy();
  expect(within(rates).getByText("300 RPS")).toBeTruthy();
  expect(within(rates).getByText("gateway-to-middle · Retries · Baseline")).toBeTruthy();
  expect(within(rates).getByText("gateway-to-middle · Successes · Baseline")).toBeTruthy();
  const errors = screen.getByRole("region", { name: "Errors and rejections" });
  expect(within(errors).getByText("gateway-to-middle · Timeouts · Baseline")).toBeTruthy();
  const state = screen.getByRole("region", { name: "Call state" });
  expect(within(state).getByText("2 requests")).toBeTruthy();
  expect(within(state).getByText("0.4 requests")).toBeTruthy();
  expect(within(state).getByText("0.5 requests")).toBeTruthy();
  const latency = screen.getByRole("region", { name: "Latency" });
  expect(within(latency).getByText("gateway-to-middle · Mean latency · Baseline")).toBeTruthy();
  expect(within(latency).getByText("6 ms")).toBeTruthy();
  expect(within(latency).getAllByText("8 ms")).toHaveLength(2);
});

it("keeps a Ctrl-selected service alongside a call and follows a replacement canvas selection", async () => {
  stubSeries();
  const props = { runId: "run-mixed", summary, manifest: shortManifest, model, experiment, catalog,
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 1 };
  const view = render(<Timeline {...props} selectedNodes={["gateway", "gateway-to-middle"]} />);
  await screen.findByText("gateway-to-middle · Sent attempts · Baseline");
  expect(screen.getByText("gateway · Handler utilization · Baseline")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "gateway" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "gateway-to-middle" }) as HTMLInputElement).checked).toBe(true);

  view.rerender(<Timeline {...props} selectedNodes={["middle-to-dependency"]} />);
  await waitFor(() => expect(screen.queryByText("gateway-to-middle · Sent attempts · Baseline")).toBeNull());
  expect(screen.queryByText("gateway · Handler utilization · Baseline")).toBeNull();
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
  expect(within(latency).getByText("gateway-to-middle timeout · Baseline")).toBeTruthy();
  expect(within(latency).getByText("25 ms")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "no-retries" } });
  await waitFor(() => expect(within(latency).getByText("gateway-to-middle timeout · No retries")).toBeTruthy());
  expect(within(latency).getByText("70 ms")).toBeTruthy();
});


it("restores an element hidden with Timeline checkboxes on a new Show on Timeline request", async () => {
  stubSeries();
  const props = { runId: "run-show", summary, manifest: shortManifest, model, experiment, catalog,
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 1, selectedNodes: ["gateway-to-middle"] };
  const view = render(<Timeline {...props} selectionRequest={0} />);
  await screen.findByText("gateway-to-middle · Sent attempts · Baseline");
  fireEvent.click(screen.getByRole("checkbox", { name: "gateway-to-middle" }));
  await waitFor(() => expect(screen.queryByText("gateway-to-middle · Sent attempts · Baseline")).toBeNull());
  view.rerender(<Timeline {...props} selectionRequest={1} />);
  expect(await screen.findByText("gateway-to-middle · Sent attempts · Baseline")).toBeTruthy();
});

it("groups only model outputs by element, without unrelated types or duplicate metric choices", async () => {
  stubSeries();
  const fullCatalog = (await import("../../test/catalog.json")).default as import("../../api/apiTypes").Catalog;
  const simpleModel = { ...model, blocks: { client: model.blocks.client, gateway: model.blocks.gateway,
    database: { type: "database", params: {} } }, connections: [model.connections[0],
    { ...model.connections[1], id: "gateway-to-database", from: "gateway", to: "database" }] };
  render(<Timeline runId="model-choices" summary={summary} manifest={shortManifest} model={simpleModel} experiment={experiment}
    catalog={fullCatalog} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={0} selectedNodes={["gateway"]} />);
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  const choices = screen.getByText("Elements and metrics").parentElement!;
  expect(within(choices).getAllByRole("group")).toHaveLength(4);
  const service = within(choices).getByRole("group", { name: "gateway · Service" });
  expect(within(service).getAllByRole("checkbox")).toHaveLength(18);
  expect(within(service).getAllByRole("checkbox", { checked: true })).toHaveLength(9);
  const names = within(service).getAllByRole("checkbox").map(input => input.parentElement!.textContent);
  expect(new Set(names).size).toBe(names.length);
  expect(within(choices).queryByText(/pooler|routing|connection pool/i)).toBeNull();
  expect((within(choices).getByRole("checkbox", { name: "database" }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(within(choices).getByRole("checkbox", { name: "database" }));
  const database = within(choices).getByRole("group", { name: "database · Database" });
  expect(within(database).getByRole("checkbox", { name: "Connection utilization" })).toBeTruthy();
  expect(within(database).queryByRole("checkbox", { name: "Handler utilization" })).toBeNull();
});

it("keeps metric choices independent for each selected element", async () => {
  stubSeries();
  render(<Timeline runId="element-metrics" summary={summary} manifest={shortManifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={0} selectedNodes={["gateway", "middle"]} />);
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  const gateway = screen.getByRole("group", { name: "gateway · Service" });
  const middle = screen.getByRole("group", { name: "middle · Service" });
  fireEvent.click(within(gateway).getByRole("checkbox", { name: "p99 latency" }));
  expect((within(gateway).getByRole("checkbox", { name: "p99 latency" }) as HTMLInputElement).checked).toBe(true);
  expect((within(middle).getByRole("checkbox", { name: "p99 latency" }) as HTMLInputElement).checked).toBe(false);
  expect(await screen.findByText("gateway · p99 latency · Baseline")).toBeTruthy();
});

it("uses distinct variant colors and readable variant names for node and connection series", async () => {
  stubSeries();
  render(<Timeline runId="variant-colors" summary={summary} manifest={shortManifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="baseline" pointId="p0" replication={0} cursorWindow={0} selectedNodes={["gateway", "gateway-to-middle"]} />);
  await screen.findByRole("region", { name: "Queue" });
  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "no-retries" } });
  const queue = screen.getByRole("region", { name: "Queue" });
  await waitFor(() => expect(within(queue).getAllByRole("term")).toHaveLength(2));
  const keys = queue.querySelectorAll<HTMLElement>(".timeline-line-key");
  expect(keys[0].style.borderColor).not.toBe(keys[1].style.borderColor);
  expect(keys[1].classList.contains("timeline-line-key--comparison")).toBe(true);
  expect(within(queue).getByText("gateway · Mean queue · Baseline")).toBeTruthy();
  expect(within(queue).getByText("gateway · Mean queue · No retries")).toBeTruthy();
  const rates = screen.getByRole("region", { name: "Rates" });
  expect(within(rates).getByText("gateway-to-middle · Sent attempts · Baseline")).toBeTruthy();
  expect(await within(rates).findByText("gateway-to-middle · Sent attempts · No retries")).toBeTruthy();
  const primaryColors = [...rates.querySelectorAll<HTMLElement>(".timeline-line-key:not(.timeline-line-key--comparison)")].map(key => key.style.borderColor);
  const comparisonColors = [...rates.querySelectorAll<HTMLElement>(".timeline-line-key--comparison")].map(key => key.style.borderColor);
  expect(new Set(primaryColors).size).toBe(2);
  expect(new Set(comparisonColors).size).toBe(2);
  expect(primaryColors.some(color => comparisonColors.includes(color))).toBe(false);
  expect(queue.textContent).not.toContain("no-retries");
});
