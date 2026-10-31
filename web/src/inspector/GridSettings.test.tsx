import { useReducer } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Catalog, ExperimentFile, ModelFile } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { setLanguage } from "../i18n";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState } from "../workspace/editor";
import { RunSettings } from "./RunSettings";

const gridCatalog = structuredClone(catalog);
for (const param of gridCatalog.types.find((type) => type.id === "call")!.params) {
  if (param.name === "timeout" || param.name === "attempts") param.sweepable = true;
}
gridCatalog.types.find((type) => type.id === "service")!.params.find((param) => param.name === "processing")!
  .fields.find((param) => param.name === "mean")!.sweepable = true;

function Settings({ initialExperiment = experiment, initialCatalog = gridCatalog, initialModel = model }: { initialExperiment?: ExperimentFile; initialCatalog?: Catalog; initialModel?: ModelFile }) {
  const documents = { model: initialModel, layout, experiment: initialExperiment };
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...documents, saved: documents, experimentPath: "test.experiment.json", modelPath: "test.model.json",
    layoutPath: "test.layout.json", versions: { model: "m", layout: "l", experiment: "e" },
  } }));
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <button onClick={() => dispatch({ type: "redo" })}>Redo</button>
    <RunSettings catalog={initialCatalog} model={initialModel} experiment={state.loaded!.experiment} editable invalid={false}
      onCommand={(command) => dispatch({ type: "command", command })} onValidity={vi.fn()} />
    <output data-testid="grid-document">{JSON.stringify(state.loaded!.experiment.grid)}</output>
  </>;
}

it.each([
  { path: "gateway-to-middle.circuitBreaker.minimumCalls", values: [5, 10] },
  { path: "gateway-to-middle.retryBudget.ratio", values: ["10%", "20%"] },
  { path: "gateway-to-middle.fallback.processing", values: ["1ms", "2ms"] },
])("preserves imported policy axis $path read-only and excludes policies from new choices", axis => {
  render(<Settings initialCatalog={serverCatalog as Catalog} initialExperiment={{ ...experiment, grid: [axis] }} />);
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Axis 1 parameter" }).disabled).toBe(true);
  expect(screen.getByLabelText<HTMLInputElement>("Axis 1 value 1").readOnly).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add value to axis 1" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove axis 1 value 1" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove grid axis 1" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add grid axis" }));
  const second = screen.getByRole<HTMLSelectElement>("combobox", { name: "Axis 2 parameter" });
  expect([...second.options].some(option => /\.(circuitBreaker|retryBudget|fallback)\./.test(option.value))).toBe(false);
  fireEvent.change(second, { target: { value: "gateway-to-middle.timeout" } });
  const value = screen.getByLabelText("Axis 2 value 1");
  fireEvent.change(value, { target: { value: "70ms" } });
  fireEvent.blur(value);
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)).toEqual([
    axis, { path: "gateway-to-middle.timeout", values: ["70ms"] },
  ]);
});

it.each(["fixed", "lognormal"])("offers only applicable sweep fields for %s", kind => {
  const conditional = structuredClone(serverCatalog) as Catalog;
  conditional.types.find(type => type.id === "service")!.params.find(param => param.name === "processing")!
    .fields.find(field => field.name === "stdDev")!.sweepable = true;
  const initialModel = { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway,
    params: { ...model.blocks.gateway.params, processing: { kind, mean: "1ms", ...(kind === "lognormal" ? { stdDev: "1ms" } : {}) } },
  } }, connections: model.connections.map(edge => edge.id === "gateway-to-middle"
    ? { ...edge, params: { ...edge.params, backoff: { kind: "none" } } } : edge) };
  render(<Settings initialCatalog={conditional} initialModel={initialModel} />);
  fireEvent.click(screen.getByRole("button", { name: "Add grid axis" }));
  const paths = [...screen.getByRole<HTMLSelectElement>("combobox", { name: "Axis 1 parameter" }).options].map(option => option.value);
  expect(paths.includes("gateway.processing.stdDev")).toBe(kind === "lognormal");
  expect(paths).not.toContain("gateway-to-middle.backoff.base");
  expect(paths).toContain("middle-to-dependency.backoff.base");
});

it("excludes the outgoing pooler's forbidden call pool from sweep parameters", () => {
  const initialModel: ModelFile = { ...model, blocks: { ...model.blocks,
    pooler: { type: "pooler", params: { poolSize: 3 } }, database: { type: "database", params: { maxConnections: 10 } },
  }, connections: [...model.connections,
    { id: "pooler-call", type: "call", from: "pooler", to: "database", params: { timeout: "1s" } },
  ] };
  render(<Settings initialCatalog={serverCatalog as Catalog} initialModel={initialModel} />);
  fireEvent.click(screen.getByRole("button", { name: "Add grid axis" }));
  const paths = [...screen.getByRole<HTMLSelectElement>("combobox", { name: "Axis 1 parameter" }).options].map(option => option.value);
  expect(paths).toContain("pooler-call.timeout");
  expect(paths).toContain("gateway-to-middle.pool.size");
  expect(paths.some(path => path.startsWith("pooler-call.pool."))).toBe(false);
});

it.each([
  { path: "gateway-to-middle.attempts", values: [3], expected: [3, 4, 5] },
  { path: "gateway-to-middle.attempts", values: [2, 4], expected: [2, 4, 6, 8] },
  { path: "gateway-to-middle.timeout", values: ["80ms"], expected: ["80ms", "81ms", "82ms"] },
  { path: "gateway-to-middle.timeout", values: ["100ms", "0.2s"], expected: ["100ms", "0.2s", "0.3s", "0.4s"] },
])("adds distinct values using the prior step and written units: $values", ({ path, values, expected }) => {
  render(<Settings initialExperiment={{ ...experiment, grid: [{ path, values }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)[0].values).toEqual(expected);
});

it.each([[1, 3], [3, 1]])("finds a remaining valid integer from %j and disables Add when the range is full", (...values) => {
  const bounded = structuredClone(gridCatalog);
  Object.assign(bounded.types.find(type => type.id === "call")!.params.find(param => param.name === "attempts")!, { minimum: 1, maximum: 3 });
  render(<Settings initialCatalog={bounded} initialExperiment={{ ...experiment, grid: [{ path: "gateway-to-middle.attempts", values }] }} />);
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add value to axis 1" });
  fireEvent.click(add);
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)[0].values).toEqual([...values, 2]);
  expect(add.disabled).toBe(true);
});

it("avoids canonical quantity duplicates and respects an exclusive lower bound", () => {
  const bounded = structuredClone(gridCatalog);
  Object.assign(bounded.types.find(type => type.id === "call")!.params.find(param => param.name === "timeout")!, { exclusiveMinimum: 0, maximum: 2 });
  render(<Settings initialCatalog={bounded} initialExperiment={{ ...experiment, grid: [{ path: "gateway-to-middle.timeout", values: ["2ms", "0.001s"] }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  const values = JSON.parse(screen.getByTestId("grid-document").textContent!)[0].values;
  expect(values.slice(0, 2)).toEqual(["2ms", "0.001s"]);
  expect(values[2]).toBe("0.0005s");
});

it("continues decimal number steps without addition noise", () => {
  const numeric = structuredClone(gridCatalog);
  numeric.types.find(type => type.id === "call")!.params.find(param => param.name === "backoff")!
    .fields.find(param => param.name === "multiplier")!.sweepable = true;
  render(<Settings initialCatalog={numeric} initialExperiment={{ ...experiment, grid: [{ path: "gateway-to-middle.backoff.multiplier", values: [0.1, 0.2] }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)[0].values).toEqual([0.1, 0.2, 0.3, 0.4]);
});

it("keeps integer suggestions within the safe range near its upper boundary", () => {
  render(<Settings initialExperiment={{ ...experiment, grid: [{ path: "gateway-to-middle.attempts", values: [Number.MAX_SAFE_INTEGER] }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)[0].values).toEqual([9007199254740991, 9007199254740990]);
});

it("keeps probability suggestions inside canonical bounds and avoids equivalent quantity spellings", () => {
  const probability = structuredClone(gridCatalog);
  probability.types.find(type => type.id === "service")!.params.find(param => param.name === "failureRate")!.sweepable = true;
  render(<Settings initialCatalog={probability} initialExperiment={{ ...experiment, grid: [{ path: "gateway.failureRate", values: ["99%"] }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)[0].values).toEqual(["99%", "100%", "98%"]);
});

it.each([
  { path: "gateway.failureRate", values: ["100%", "50%", "0%"], expected: "25%" },
  { path: "gateway.failureRate", values: ["0%", "50%", "100%"], expected: "25%" },
  { path: "gateway-to-middle.backoff.multiplier", values: [1, 0.5, 0], expected: 0.25 },
  { path: "gateway-to-middle.backoff.multiplier", values: [0, 0.5, 1], expected: 0.25 },
])("finds an unused interior value when the boundary step is exhausted: $values", ({ path, values, expected }) => {
  const bounded = structuredClone(gridCatalog);
  const descriptor = path === "gateway.failureRate"
    ? bounded.types.find(type => type.id === "service")!.params.find(param => param.name === "failureRate")!
    : bounded.types.find(type => type.id === "call")!.params.find(param => param.name === "backoff")!.fields.find(param => param.name === "multiplier")!;
  Object.assign(descriptor, { sweepable: true, minimum: 0, maximum: 1 });
  render(<Settings initialCatalog={bounded} initialExperiment={{ ...experiment, grid: [{ path, values }] }} />);
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add value to axis 1" });
  expect(add.disabled).toBe(false);
  fireEvent.click(add);
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)[0].values).toEqual([...values, expected]);
});

it("keeps an unavailable axis readable while its raw path remains a technical detail", () => {
  render(<Settings initialExperiment={{ ...experiment, grid: [{ path: "removed-service.handlers", values: [4] }] }} />);
  expect(screen.getByRole("option", { name: "Handlers · removed-service (unavailable)" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Handlers · removed-service" }).textContent).not.toContain("removed-service.handlers");
});

it("edits catalog paths and values in shared settings with undo/redo and a two-axis limit", () => {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Add grid axis" }));
  const path = screen.getByLabelText("Axis 1 parameter");
  expect(screen.getByRole("option", { name: "Processing time · Mean · gateway" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Processing time · Distribution · gateway" })).toBeNull();
  fireEvent.change(path, { target: { value: "gateway-to-middle.timeout" } });
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  const value = screen.getByLabelText("Axis 1 value 2");
  fireEvent.change(value, { target: { value: "0.04s" } });
  fireEvent.blur(value);
  expect(screen.getByTestId("grid-document").textContent).toBe('[{"path":"gateway-to-middle.timeout","values":["80ms","0.04s"]}]');
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect((screen.getByLabelText("Axis 1 value 2") as HTMLInputElement).value).toBe("81ms");
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect((screen.getByLabelText("Axis 1 value 2") as HTMLInputElement).value).toBe("0.04s");
  fireEvent.click(screen.getByRole("button", { name: "Add grid axis" }));
  expect((screen.getByRole("button", { name: "Add grid axis" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Axis 2 parameter"), { target: { value: "gateway-to-middle.attempts" } });
  const attempts = screen.getByLabelText("Axis 2 value 1");
  fireEvent.change(attempts, { target: { value: "1" } });
  fireEvent.blur(attempts);
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)[1]).toEqual({ path: "gateway-to-middle.attempts", values: [1] });
  fireEvent.click(screen.getByRole("button", { name: "Remove grid axis 1" }));
  expect(JSON.parse(screen.getByTestId("grid-document").textContent!)).toEqual([{ path: "gateway-to-middle.attempts", values: [1] }]);
});

it("shows grid diagnostics at paths, value lists and individual values", () => {
  const finding = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "Invalid timeout", document: "test.experiment.json",
    pointer: "/grid/0/values/0", path: "gateway-to-middle", variant: "baseline" };
  render(<RunSettings catalog={gridCatalog} model={model}
    experiment={{ ...experiment, grid: [{ path: "gateway-to-middle.timeout", values: ["0ms"] }] }}
    editable invalid={false} onCommand={vi.fn()} onValidity={vi.fn()} fieldDiagnostics={new Map([
      ["grid.0.path", [{ ...finding, message: "Overlapping axis" }]],
      ["grid.0.values", [{ ...finding, message: "Empty values" }]],
      ["grid.0.values.0", [finding]],
    ])} />);
  expect(screen.getByText(/Overlapping axis/)).toBeTruthy();
  expect(screen.getByText(/Empty values/)).toBeTruthy();
  expect(screen.getByLabelText("Axis 1 value 1").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText(/Invalid timeout/)).toBeTruthy();
});


const sweep: ExperimentFile = {
  ...experiment,
  variants: [{ id: "baseline", label: "Baseline", overrides: {} }],
  execution: { ...experiment.execution, replications: 10 },
  grid: [
    { path: "gateway-to-middle.timeout", values: ["1s", "3s", "5s"] },
    { path: "gateway-to-middle.attempts", values: [1, 2, 3] },
  ],
};

afterEach(() => setLanguage("en"));

it("explains the sweep and derives its size from axes, variants and replications", () => {
  const props = { catalog: gridCatalog, model, editable: true, invalid: false, onCommand: vi.fn(), onValidity: vi.fn() };
  const view = render(<RunSettings {...props} experiment={{ ...sweep, grid: [] }} />);
  expect(screen.getByText("Runs the experiment for every combination of values; results are on the Map tab")).toBeTruthy();
  expect(screen.getByText("Applies to all variants and overrides their values of these parameters.")).toBeTruthy();
  expect(screen.queryByLabelText("Sweep size")).toBeNull();
  view.rerender(<RunSettings {...props} experiment={{ ...sweep, grid: sweep.grid!.slice(0, 1) }} />);
  expect(screen.getByLabelText("Sweep size").textContent).toBe("3 points × 1 variant × 10 replications = 30 runs");
  view.rerender(<RunSettings {...props} experiment={sweep} />);
  expect(screen.getByLabelText("Sweep size").textContent).toBe("3 × 3 = 9 points × 1 variant × 10 replications = 90 runs");
  view.rerender(<RunSettings {...props} experiment={{ ...sweep, variants: [...sweep.variants, { id: "hello", label: "Hello", overrides: {} }] }} />);
  expect(screen.getByLabelText("Sweep size").textContent).toBe("3 × 3 = 9 points × 2 variants × 10 replications = 180 runs");
});

it("updates sweep cost after editing replications and adding or removing a value", () => {
  render(<Settings initialExperiment={sweep} />);
  const replications = screen.getByLabelText("Replications");
  fireEvent.change(replications, { target: { value: "5" } });
  fireEvent.blur(replications);
  expect(screen.getByLabelText("Sweep size").textContent).toContain("5 replications = 45 runs");
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  expect(screen.getByLabelText("Sweep size").textContent).toBe("4 × 3 = 12 points × 1 variant × 5 replications = 60 runs");
  fireEvent.click(screen.getByRole("button", { name: "Remove axis 1 value 4" }));
  expect(screen.getByLabelText("Sweep size").textContent).toContain("= 45 runs");
});

it("uses an element-aware axis heading and one help hint for all its values", () => {
  const described = structuredClone(gridCatalog);
  described.types.find(type => type.id === "call")!.params.find(param => param.name === "timeout")!.description = "Maximum wait for one attempt.";
  render(<RunSettings catalog={described} model={model} experiment={sweep} editable invalid={false} onCommand={vi.fn()} onValidity={vi.fn()} />);
  expect(screen.getByRole("group", { name: "Timeout · gateway → middle" })).toBeTruthy();
  const hints = screen.getAllByRole("button", { name: /More about:.*Timeout/ });
  expect(hints).toHaveLength(1);
  fireEvent.click(hints[0]);
  expect(screen.getByRole("tooltip").textContent).toBe("Maximum wait for one attempt.");
  expect(screen.getByLabelText("Axis 1 value 1").closest(".grid-value")).toBeTruthy();
});

const warning = {
  code: "LINT_TIMEOUT_BUDGET", severity: "WARNING" as const,
  message: "Timeout 1000 ms is below the downstream budget 2000 ms (points: p0, p1, p2)",
  args: { timeoutMs: 1000, requiredMs: 2000, points: "p0, p1, p2" },
  document: "test.experiment.json", pointer: "/grid/0/values/0", path: "gateway-to-middle", variant: "baseline",
};

it("groups sweep warnings across variants and replaces point IDs with axis values", () => {
  render(<RunSettings catalog={gridCatalog} model={model}
    experiment={{ ...sweep, variants: [...sweep.variants, { id: "hello", label: "Hello", overrides: {} }] }} editable invalid={false}
    onCommand={vi.fn()} onValidity={vi.fn()} fieldDiagnostics={new Map([["grid.0.values.0", [warning, { ...warning, args: { points: "p0, p1, p2", requiredMs: 2000, timeoutMs: 1000 }, variant: "hello" }]]])} />);
  const findings = screen.getAllByText(/LINT_TIMEOUT_BUDGET/).map(code => code.closest("li")!);
  expect(findings).toHaveLength(1);
  expect(findings[0].textContent).toContain("at Timeout · gateway → middle = 1s");
  expect(findings[0].textContent).toContain("in variants: Baseline, Hello");
  expect(findings[0].textContent).not.toMatch(/p[0-9]/);
});

it.each([
  { message: "A different warning" },
  { args: { ...warning.args, requiredMs: 3000 } },
  { args: { ...warning.args, points: "p3, p4, p5" } },
  { pointer: "/grid/0/values/1" },
  { severity: "ERROR" as const },
])("keeps distinct sweep findings separate: %j", difference => {
  render(<RunSettings catalog={gridCatalog} model={model} experiment={sweep} editable invalid={false}
    onCommand={vi.fn()} onValidity={vi.fn()} fieldDiagnostics={new Map([["grid.0.values.0", [warning, { ...warning, ...difference, variant: "hello" }]]])} />);
  expect(screen.getAllByText(/LINT_TIMEOUT_BUDGET/)).toHaveLength(2);
});

it("preserves correlated combinations and unknown point IDs", () => {
  const findings = [
    { ...warning, args: { ...warning.args, points: "p0, p4" } },
    { ...warning, args: { ...warning.args, points: "p99" } },
  ];
  render(<RunSettings catalog={gridCatalog} model={model} experiment={sweep} editable invalid={false}
    onCommand={vi.fn()} onValidity={vi.fn()} fieldDiagnostics={new Map([["grid.0.values.0", findings]])} />);
  const messages = screen.getAllByText(/LINT_TIMEOUT_BUDGET/).map(code => code.closest("li")!);
  expect(messages[0].textContent).toContain("Timeout · gateway → middle = 1s, Attempts · gateway → middle = 1; Timeout · gateway → middle = 3s, Attempts · gateway → middle = 2");
  expect(messages[1].textContent).toContain("Point 100");
  expect(messages[1].textContent).not.toContain("p99");
});

it("localizes sweep sizes and plural forms in Russian", () => {
  setLanguage("ru");
  render(<RunSettings catalog={gridCatalog} model={model} experiment={{ ...sweep, variants: [...sweep.variants, { id: "hello", overrides: {} }] }}
    editable invalid={false} onCommand={vi.fn()} onValidity={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Перебор параметров" })).toBeTruthy();
  expect(screen.getByLabelText("Размер перебора").textContent).toBe("3 × 3 = 9 точек × 2 варианта × 10 повторений = 180 прогонов");
});


it("resolves points in legacy fallback messages and names unknown variants without their IDs", () => {
  const legacy = { code: "CUSTOM_WARNING", severity: "WARNING" as const, message: "Original warning (points: p0, p1)", variant: "baseline" };
  render(<RunSettings catalog={gridCatalog} model={model} experiment={sweep} editable invalid={false}
    onCommand={vi.fn()} onValidity={vi.fn()} fieldDiagnostics={new Map([["grid", [legacy, { ...legacy, variant: "hello" }]]])} />);
  const message = screen.getByText(/CUSTOM_WARNING/).closest("li")!;
  expect(message.textContent).toContain("Original warning (at Timeout · gateway → middle = 1s, Attempts · gateway → middle = 1, 2)");
  expect(message.textContent).toContain("in variants: Baseline, Variant");
  expect(message.textContent).not.toMatch(/p0|p1|hello/);
});

it("distinguishes axes with the same parameter title by their elements", () => {
  const sameTitle = { ...sweep, grid: [
    { path: "gateway-to-middle.timeout", values: ["1s", "3s"] },
    { path: "middle-to-dependency.timeout", values: ["1s", "3s"] },
  ] };
  render(<RunSettings catalog={gridCatalog} model={model} experiment={sameTitle} editable invalid={false}
    onCommand={vi.fn()} onValidity={vi.fn()} fieldDiagnostics={new Map([["grid", [{ ...warning, args: { ...warning.args, points: "p0" } }]]])} />);
  expect(screen.getByText(/LINT_TIMEOUT_BUDGET/).closest("li")!.textContent)
    .toContain("Timeout · gateway → middle = 1s, Timeout · middle → dependency = 1s");
});
