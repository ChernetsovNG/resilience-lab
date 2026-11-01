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

function fixture() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const { run, runModel, runExperiment } = replicaFixture();
  const load = vi.spyOn(seriesLoader, "load").mockResolvedValue([]);
  const connections = vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue([]);
  const classes = vi.spyOn(seriesLoader, "loadClasses").mockResolvedValue([]);
  const props = { runId: "policies", summary: run, model: runModel, experiment: runExperiment, catalog: fullCatalog as Catalog,
    manifest: { ...manifest, series: { ...manifest.series!, warmupMs: 0, measurementMs: 125, windowMs: 100 } },
    activeVariantId: "baseline", pointId: "p0", replication: 0, cursorWindow: 0, selectedNodes: ["gateway-to-middle"] };
  return { props, load, connections, classes };
}

it("colors breaker windows by the caller-average share and shares the cursor with charts", async () => {
  const { props, connections } = fixture();
  props.model.connections.find(connection => connection.id === "gateway-to-middle")!.params.circuitBreaker = { failureThreshold: 1 };
  props.summary.variants[0].points[0].aggregate.groups.push({ id: "gateway-to-middle", kind: "CONNECTION",
    instances: [1, 2, 3].map(replica => ({ id: `gateway-to-middle#${replica}`, replica })) });
  connections.mockResolvedValue([{ id: "gateway-to-middle", windows: [
    { startMs: 0, durationMs: 100, circuitOpenMs: 120 },
    { startMs: 100, durationMs: 25, circuitOpenMs: 0 },
  ].map(window => ({ ...window, clientOriginalArrivals: 0, failuresByReason: {}, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
    sentAttempts: 3, retries: 0, succeeded: 1, failed: 2, timeouts: 2, orphaned: 0,
    inFlightIntegralMs: 0, orphanedIntegralMs: 0, backoffIntegralMs: 0,
    latency: recordedWindow().latency, slotPools: {} })) }]);
  const onCursorChange = vi.fn();
  const view = render(<Timeline {...props} onCursorChange={onCursorChange} />);
  const band = await screen.findByRole("slider", { name: /Circuit open.*gateway/ });
  const windows = band.querySelectorAll("rect[data-share]");
  expect(windows[0].getAttribute("data-share")).toBe("0.4");
  expect(windows[1].getAttribute("data-share")).toBe("0");
  expect(windows[0].textContent).toContain("open 40% of window, averaged over 3 caller replicas");
  fireEvent.keyDown(band, { key: "End" });
  expect(onCursorChange).toHaveBeenLastCalledWith(1);
  view.rerender(<Timeline {...props} cursorWindow={1} onCursorChange={onCursorChange} />);
  expect(band.getAttribute("aria-valuenow")).toBe("1");
  expect(band.querySelector('[data-cursor-window="1"]')).toBeTruthy();
});

it("uses a compared variant's own caller count, while leaving the baseline lane unchanged", async () => {
  const { props, connections } = fixture();
  props.model.connections.find(connection => connection.id === "gateway-to-middle")!.params.circuitBreaker = {};
  const compared = structuredClone(props.summary.variants[0]);
  compared.id = "other"; compared.label = "Other";
  compared.points[0].aggregate.groups.push({ id: "gateway-to-middle", kind: "CONNECTION",
    instances: [1, 2, 3].map(replica => ({ id: `gateway-to-middle#${replica}`, replica })) });
  props.summary.variants.push(compared);
  props.experiment.variants.push({ id: "other", label: "Other", overrides: { "gateway.replicas": 3 } });
  connections.mockImplementation(async request => [{ id: "gateway-to-middle", windows: [{
    startMs: 0, durationMs: 100, circuitOpenMs: request.variant === "other" ? 120 : 20,
    clientOriginalArrivals: 0, failuresByReason: {}, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
    sentAttempts: 3, retries: 0, succeeded: 1, failed: 2, timeouts: 2, orphaned: 0,
    inFlightIntegralMs: 0, orphanedIntegralMs: 0, backoffIntegralMs: 0, latency: recordedWindow().latency, slotPools: {},
  }] }]);
  render(<Timeline {...props} />);
  await screen.findByRole("slider", { name: /Circuit open.*Baseline/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "other" } });
  const band = await screen.findByRole("slider", { name: /Circuit open.*Other/ });
  expect(band.querySelector("rect[data-share]")?.getAttribute("data-share")).toBe("0.4");
  expect(screen.getByRole("slider", { name: /Circuit open.*Baseline/ }).querySelector("rect[data-share]")?.getAttribute("data-share")).toBe("0.2");
});

it("shows exclusion and readiness lanes only on the matching replica policies", async () => {
  const { props, load } = fixture();
  props.model.blocks.gateway.params.healthCheck = {};
  props.model.blocks.gateway.replicaOverrides!["2"].healthCheck = null;
  props.model.blocks.source = structuredClone(props.model.blocks.middle);
  props.model.connections.push({ id: "source-to-gateway", type: "call", from: "source", to: "gateway", params: { outlierDetection: {} } });
  load.mockImplementation(async request => request.nodes.map(id => ({ id,
    windows: [recordedWindow({ ejectedMs: id === "gateway#2" ? 70 : 0, notReadyMs: 0 })] })));
  render(<Timeline {...props} selectedNodes={["gateway#2"]} />);
  const lane = await screen.findByRole("slider", { name: /Ejected.*gateway#2/ });
  expect(lane.querySelector("rect[data-share]")?.getAttribute("data-share")).toBe("0.7");
  expect(screen.queryByRole("slider", { name: /Not ready.*gateway#2/ })).toBeNull();
});

it("selects request types independently of a block with the same ID and uses client catalog metrics", async () => {
  const { props, load, classes } = fixture();
  props.model.blocks.client.params.classes = [{ id: "gateway", load: [{ at: "0s", rate: "10/s" }] },
    { id: "status", load: [{ at: "0s", rate: "10/s" }] }];
  delete props.model.blocks.client.params.load;
  load.mockImplementation(async request => request.nodes.map(id => ({ id, windows: [recordedWindow({ originalArrivals: 900 })] })));
  classes.mockImplementation(async request => request.classes.map(id => ({ id, windows: [recordedWindow({ originalArrivals: 10,
    successes: id === "status" ? 5 : 2, failures: id === "status" ? 1 : 3 })] })));
  render(<Timeline {...props} selectedNodes={["gateway"]} />);
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  for (const id of ["gateway", "status"]) {
    fireEvent.click(screen.getByRole("checkbox", { name: `Request type · ${id}` }));
    const choices = screen.getByRole("group", { name: `Request type · ${id}` });
    fireEvent.click(within(choices).getByRole("checkbox", { name: "Successes" }));
  }
  const rates = await screen.findByRole("region", { name: "Rates" });
  await waitFor(() => expect(within(rates).getByText("Request type · gateway · Successes · Baseline")).toBeTruthy());
  expect(within(rates).getByText("20 RPS")).toBeTruthy();
  expect(within(rates).getByText("50 RPS")).toBeTruthy();
  expect(classes.mock.calls.at(-1)?.[0].classes).toEqual(["gateway", "status"]);
});

it("adds no policy lanes or request-type choices to a legacy model", async () => {
  const { props, load } = fixture();
  load.mockResolvedValue([{ id: "gateway", windows: [recordedWindow()] }]);
  render(<Timeline {...props} selectedNodes={["gateway"]} />);
  await screen.findByRole("region", { name: "Rates" });
  expect(screen.queryByRole("checkbox", { name: /Request type/ })).toBeNull();
  expect(screen.queryByRole("slider", { name: /Circuit open|Ejected|Not ready/ })).toBeNull();
});

it("renders a request type that exists only in the compared variant, without inventing a baseline line", async () => {
  const { props, classes } = fixture();
  props.model.blocks.client.params.classes = [{ id: "base", load: { points: [{ time: "0s", rate: "10/s" }] } }];
  delete props.model.blocks.client.params.load;
  const other = structuredClone(props.summary.variants[0]); other.id = "other"; other.label = "Other";
  props.summary.variants.push(other);
  props.experiment.variants.push({ id: "other", label: "Other", overrides: {
    "client.classes": [{ id: "comparison", load: { points: [{ time: "0s", rate: "10/s" }] } }],
  } });
  classes.mockImplementation(async request => request.classes.filter(id => id === (request.variant === "other" ? "comparison" : "base"))
    .map(id => ({ id, windows: [recordedWindow({ originalArrivals: 4 })] })));
  render(<Timeline {...props} selectedNodes={[]} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Compare variant" }), { target: { value: "other" } });
  fireEvent.click(screen.getByText("Elements and metrics", { exact: true }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Request type · comparison" }));
  expect(await screen.findByText("Request type · comparison · Original requests · Other")).toBeTruthy();
  expect(screen.queryByText("Request type · comparison · Original requests · Baseline")).toBeNull();
});

it("offers the saved default request type when explicit request types coexist with a load-only client", () => {
  const { props } = fixture();
  props.model.blocks.client.params.classes = [{ id: "status", load: { points: [{ time: "0s", rate: "10/s" }] } }];
  delete props.model.blocks.client.params.load;
  props.model.blocks.partner = { type: "client", params: { load: { points: [{ time: "0s", rate: "10/s" }] }, deadline: "1s" } };
  render(<Timeline {...props} />);
  expect(screen.getByRole("checkbox", { name: "Request type · default" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Request type · status" })).toBeTruthy();
});
