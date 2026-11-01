import { useReducer } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Catalog, ModelFile } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState, setModelParam, type EditorDocuments } from "../workspace/editor";
import { applyOverrides, elementOf } from "../workspace/params";
import { Inspector } from "./Inspector";

const catalog = serverCatalog as Catalog;
const call = "gateway-to-middle";
const breaker = { failureRate: "50%", minimumCalls: 10, window: 20, openDuration: "5s", halfOpenCalls: 3 };
const healthCheck = { interval: "10s", timeout: "1s", unhealthyThreshold: 3, healthyThreshold: 1, processing: "1ms" };
const source: ModelFile = { ...model, blocks: { ...model.blocks,
  middle: { ...model.blocks.middle, params: { ...model.blocks.middle.params, replicas: 3 } },
  router: { type: "router", params: { policy: "roundRobin" } },
} };
const documents = (): EditorDocuments => ({ model: structuredClone(source), experiment: structuredClone(experiment), layout });

function Editor({ initial = documents(), selected = call, variantId = null }: {
  initial?: EditorDocuments; selected?: string | null; variantId?: string | null;
}) {
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...initial, saved: initial, experimentPath: "e.experiment.json", modelPath: "m.model.json", layoutPath: "l.layout.json",
    versions: { model: "m", experiment: "e", layout: "l" },
  } }));
  const loaded = state.loaded!;
  const overrides = loaded.experiment.variants.find(variant => variant.id === variantId)?.overrides ?? {};
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <Inspector catalog={catalog} model={variantId === null ? loaded.model : applyOverrides(loaded.model, overrides, catalog)}
      baseModel={loaded.model} experiment={loaded.experiment} selected={selected} editable overrides={overrides} variantId={variantId}
      onParam={(id, path, value) => dispatch({ type: "command", command: setModelParam(id, path, value, catalog) })}
      onCommand={command => dispatch({ type: "command", command })} onValidity={() => {}} />
    <output data-testid="stored">{JSON.stringify({ model: loaded.model, experiment: loaded.experiment, layout: loaded.layout })}</output>
    <output data-testid="history">{state.past.length}</output>
  </>;
}

const stored = () => JSON.parse(screen.getByTestId("stored").textContent!) as EditorDocuments;
const history = (count: number) => expect(screen.getByTestId("history").textContent).toBe(String(count));
const policy = (name: string) => within(document.querySelector<HTMLElement>(`[data-policy="${name}"]`)!);
const add = (title: string) => {
  fireEvent.click(screen.getByRole("button", { name: "+ Add policy" }));
  fireEvent.click(screen.getByRole("menuitem", { name: title }));
};
const edit = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
};
afterEach(() => localStorage.clear());

it.each([
  [call, "circuitBreaker", "Circuit breaker", breaker],
  [call, "retryBudget", "Retry budget", { ratio: "20%", minPerSecond: "10/s", window: "10s" }],
  [call, "fallback", "Fallback", { on: ["circuitOpen"], processing: "1ms" }],
  [call, "outlierDetection", "Outlier detection", { consecutiveFailures: 5, baseEjection: "30s", maxEjected: "50%" }],
  ["gateway", "rateLimit", "Rate limit", { rate: "100/s", burst: 10 }],
  ["gateway", "healthCheck", "Health check", healthCheck],
  ["router", "outlierDetection", "Outlier detection", { consecutiveFailures: 5, baseEjection: "30s", maxEjected: "50%" }],
] as const)("adds/removes %s %s as atomic Undo commands using catalog field defaults", (selected, name, title, initial) => {
  const before = documents();
  render(<Editor initial={before} selected={selected} />);
  expect(document.querySelectorAll("[data-policy]")).toHaveLength(0);
  add(title);
  expect(elementOf(stored().model, selected)?.params[name]).toEqual(initial);
  history(1);
  expect(policy(name).getByRole("group", { name: title })).toBeTruthy();
  if (selected === "router") expect(screen.getByRole<HTMLButtonElement>("button", { name: "+ Add policy" }).disabled).toBe(true);
  else {
  fireEvent.click(screen.getByRole("button", { name: "+ Add policy" }));
  const existing = screen.getByRole<HTMLButtonElement>("menuitem", { name: new RegExp(`^${title}`) });
  expect(existing.disabled).toBe(true);
  expect(existing.textContent).toContain("Already added");
  fireEvent.click(screen.getByRole("button", { name: "+ Add policy" }));
  }
  fireEvent.click(policy(name).getByRole("button", { name: "Remove policy" }));
  expect(elementOf(stored().model, selected)?.params).not.toHaveProperty(name);
  history(2);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(elementOf(stored().model, selected)?.params[name]).toEqual(initial);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(stored()).toEqual(before);
});

it("keeps unavailable outlier detection visible with its reason on a single-target call", () => {
  render(<Editor initial={{ ...documents(), model }} />);
  fireEvent.click(screen.getByRole("button", { name: "+ Add policy" }));
  const item = screen.getByRole<HTMLButtonElement>("menuitem", { name: /Outlier detection/ });
  expect(item.disabled).toBe(true);
  expect(item.textContent).toContain("Only for a call to a replica group");
  expect(screen.getAllByRole("menuitem")).toHaveLength(4);
});

it("sorts call policies by execution order and edits fallback failure reasons without deadline", () => {
  render(<Editor />);
  add("Fallback"); add("Circuit breaker"); add("Retry budget");
  expect([...document.querySelectorAll<HTMLElement>("[data-policy]")].map(node => node.dataset.policy))
    .toEqual(["retryBudget", "circuitBreaker", "fallback"]);
  const reasons = policy("fallback").getByRole("group", { name: "Failure reasons" });
  expect(within(reasons).queryByRole("checkbox", { name: /deadline/i })).toBeNull();
  expect(within(reasons).getAllByRole("checkbox")).toHaveLength(9);
  fireEvent.click(within(reasons).getByRole("checkbox", { name: "timeout" }));
  expect(elementOf(stored().model, call)?.params.fallback).toEqual({ on: ["circuitOpen", "timeout"], processing: "1ms" });
  history(4);
});

it("removes an inherited policy with null and restores inheritance without changing the model", () => {
  const initial = documents();
  initial.model.connections[1].params.circuitBreaker = breaker;
  render(<Editor initial={initial} variantId="baseline" />);
  fireEvent.click(policy("circuitBreaker").getByRole("button", { name: "Remove policy" }));
  expect(stored().experiment.variants[0].overrides).toEqual({ [`${call}.circuitBreaker`]: null });
  expect(policy("circuitBreaker").getByText("Removed in this variant")).toBeTruthy();
  expect(document.querySelector<HTMLDetailsElement>('[data-policy="circuitBreaker"]')!.open).toBe(false);
  expect(stored().model).toEqual(initial.model);
  history(1);
  fireEvent.click(policy("circuitBreaker").getByRole("button", { name: "Restore" }));
  expect(stored().experiment.variants[0].overrides).toEqual({});
  history(2);
});

it("adds and edits a variant policy as a complete object, then removes the variant-only override", () => {
  render(<Editor variantId="baseline" />);
  add("Circuit breaker");
  edit(policy("circuitBreaker").getByRole("textbox", { name: "Open duration" }), "7s");
  expect(stored().experiment.variants[0].overrides).toEqual({ [`${call}.circuitBreaker`]: { ...breaker, openDuration: "7s" } });
  expect(elementOf(stored().model, call)?.params).not.toHaveProperty("circuitBreaker");
  history(2);
  fireEvent.click(policy("circuitBreaker").getByRole("button", { name: "Remove policy" }));
  expect(stored().experiment.variants[0].overrides).toEqual({});
  expect(document.querySelectorAll("[data-policy]")).toHaveLength(0);
  history(3);
});

it("removes policy axes and root, null and leaf overrides in the same Undo entry", () => {
  const initial = documents();
  initial.model.connections[1].params.circuitBreaker = breaker;
  initial.experiment.grid = [{ path: `${call}.circuitBreaker.openDuration`, values: ["5s", "7s"] }, { path: "middle.handlers", values: [4] }];
  initial.experiment.variants = [
    { id: "baseline", overrides: { [`${call}.circuitBreaker`]: { ...breaker, openDuration: "9s" } } },
    { id: "leaf", overrides: { [`${call}.circuitBreaker.minimumCalls`]: 5, "middle.handlers": 2 } },
    { id: "removed", overrides: { [`${call}.circuitBreaker`]: null } },
  ];
  render(<Editor initial={initial} />);
  fireEvent.click(policy("circuitBreaker").getByRole("button", { name: "Remove policy" }));
  expect(stored().experiment.grid).toEqual([{ path: "middle.handlers", values: [4] }]);
  expect(stored().experiment.variants.map(variant => variant.overrides)).toEqual([{}, { "middle.handlers": 2 }, {}]);
  history(1);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(stored()).toEqual(initial);
});

it("offers numeric sweep fields only for enabled policies", () => {
  const initial = documents();
  initial.model.connections[1].params.circuitBreaker = breaker;
  initial.model.blocks.gateway.params.healthCheck = healthCheck;
  render(<Editor initial={initial} selected={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Add grid axis" }));
  const paths = [...screen.getByRole<HTMLSelectElement>("combobox", { name: "Axis 1 parameter" }).options].map(option => option.value);
  expect(paths).toContain(`${call}.circuitBreaker.openDuration`);
  expect(paths).toContain("gateway.healthCheck.timeout");
  expect(paths.some(path => /\.(fallback|rateLimit|outlierDetection)\./.test(path))).toBe(false);
});

it.each([
  ["healthCheck", "Health check", healthCheck, "Probe timeout", "250ms", { ...healthCheck, timeout: "250ms" }],
  ["rateLimit", "Rate limit", { rate: "100/s", burst: 10 }, "Token rate", "50/s", { rate: "50/s", burst: 10 }],
] as const)("adds and edits replica %s as a complete policy object", (name, title, initial, field, value, changed) => {
  render(<Editor selected="middle" />);
  const replicas = within(screen.getByText("Replica overrides", { exact: true }).closest("details")!);
  fireEvent.change(replicas.getByRole("combobox", { name: "Parameter for new override" }), { target: { value: name } });
  fireEvent.click(replicas.getByRole("button", { name: "Add override" }));
  expect(stored().model.blocks.middle.replicaOverrides).toEqual({ "1": { [name]: initial } });
  edit(replicas.getByRole("textbox", { name: field }), value);
  expect(stored().model.blocks.middle.replicaOverrides).toEqual({ "1": { [name]: changed } });
  history(2);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(stored().model.blocks.middle.replicaOverrides).toEqual({ "1": { [name]: initial } });
  expect(replicas.getByRole("group", { name: title })).toBeTruthy();
});
