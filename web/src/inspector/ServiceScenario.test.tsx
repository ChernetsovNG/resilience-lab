import { useCallback, useReducer, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Catalog, Diagnostic, ModelFile } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState } from "../workspace/editor";
import { Inspector } from "./Inspector";

const source: ModelFile = { ...model, connections: [...model.connections,
  { id: "a-call", type: "call", from: "gateway", to: "dependency", params: { timeout: "1s" } },
] };
const explicit: ModelFile = { ...source, blocks: { ...source.blocks, gateway: { ...source.blocks.gateway, scenario: [
  { type: "process" }, { type: "call", connection: "gateway-to-middle" },
] } } };

function Editor({ initial = source, selected = "gateway", variantId = null, catalog = serverCatalog as Catalog,
  fieldDiagnostics, focusField }: {
  initial?: ModelFile; selected?: string; variantId?: string | null; catalog?: Catalog;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>; focusField?: { path: string; request: number };
}) {
  const documents = { model: initial, layout, experiment };
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...documents, saved: documents, experimentPath: "test.experiment.json", modelPath: "test.model.json",
    layoutPath: "test.layout.json", versions: { model: "m", layout: "l", experiment: "e" },
  } }));
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const onValidity = useCallback((key: string, valid: boolean) => setInvalid(previous => {
    if (previous.has(key) === !valid) return previous;
    const next = new Set(previous);
    if (valid) next.delete(key); else next.add(key);
    return next;
  }), []);
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <Inspector catalog={catalog} model={state.loaded!.model} experiment={experiment} selected={selected}
      editable variantId={variantId} invalid={invalid.size > 0} overrides={{}} onParam={vi.fn()}
      onCommand={command => dispatch({ type: "command", command })} onValidity={onValidity}
      fieldDiagnostics={fieldDiagnostics} focusField={focusField} />
    <output data-testid="documents">{JSON.stringify({ model: state.loaded!.model, layout: state.loaded!.layout, experiment: state.loaded!.experiment })}</output>
    <output data-testid="history">{state.past.length}</output>
  </>;
}

const stored = () => JSON.parse(screen.getByTestId("documents").textContent!) as { model: ModelFile };
const scenario = () => stored().model.blocks.gateway.scenario;
const step = (number: number) => screen.getByRole("group", { name: `Step ${number}` });
const click = (name: string, root?: HTMLElement) => fireEvent.click((root ? within(root) : screen).getByRole("button", { name }));
const history = (size: number) => expect(screen.getByTestId("history").textContent).toBe(String(size));
afterEach(() => localStorage.clear());

it("reconciles the distribution of a scenario-local process in one Undo", () => {
  const initial = { ...explicit, blocks: { ...explicit.blocks, gateway: { ...explicit.blocks.gateway,
    scenario: [{ type: "process", processing: { kind: "fixed", mean: "3ms" } }, { type: "call", connection: "gateway-to-middle" }],
  } } };
  render(<Editor initial={initial} />);
  const own = within(step(1));
  expect(own.queryByRole("textbox", { name: "Standard deviation" })).toBeNull();
  fireEvent.change(own.getByRole("combobox", { name: "Distribution" }), { target: { value: "lognormal" } });
  expect(scenario()?.[0].processing).toEqual({ kind: "lognormal", mean: "3ms", stdDev: "3ms" });
  history(1);
  click("Undo");
  expect(scenario()?.[0].processing).toEqual({ kind: "fixed", mean: "3ms" });
});

it("materializes the implicit scenario in core connection-ID order with one Undo", () => {
  render(<Editor />);
  expect(within(step(1)).getByRole<HTMLSelectElement>("combobox", { name: "Step type" }).value).toBe("process");
  expect(within(step(2)).getByRole<HTMLSelectElement>("combobox", { name: "Connection" }).value).toBe("a-call");
  expect(within(step(3)).getByRole<HTMLSelectElement>("combobox", { name: "Connection" }).value).toBe("gateway-to-middle");
  expect(within(step(1)).getByRole<HTMLSelectElement>("combobox", { name: "Step type" }).disabled).toBe(true);
  history(0);
  click("Set custom scenario");
  expect(scenario()).toEqual([{ type: "process" }, { type: "call", connection: "a-call" }, { type: "call", connection: "gateway-to-middle" }]);
  history(1);
  click("Undo");
  expect(stored()).toEqual({ model: source, layout, experiment });
});

it("adds process and repeated call steps and offers only outgoing calls", () => {
  render(<Editor initial={explicit} />);
  click("Add processing");
  expect(scenario()?.at(-1)).toEqual({ type: "process" });
  history(1);
  click("Undo");
  click("Add call");
  const connection = within(step(3)).getByRole<HTMLSelectElement>("combobox", { name: "Connection" });
  expect([...connection.options].map(option => option.value)).toEqual(["a-call", "gateway-to-middle"]);
  fireEvent.change(connection, { target: { value: "gateway-to-middle" } });
  expect(scenario()).toEqual([{ type: "process" }, { type: "call", connection: "gateway-to-middle" }, { type: "call", connection: "gateway-to-middle" }]);
  history(2);
  click("Undo");
  expect(scenario()?.at(-1)).toEqual({ type: "call", connection: "a-call" });
  click("Undo");
  expect(stored()).toEqual({ model: explicit, layout, experiment });
});

it("reorders by buttons and Alt+Arrow with one Undo per move", () => {
  render(<Editor initial={explicit} />);
  click("Move up", step(2));
  expect(scenario()).toEqual([{ type: "call", connection: "gateway-to-middle" }, { type: "process" }]);
  history(1);
  click("Undo");
  fireEvent.keyDown(within(step(1)).getByRole("combobox", { name: "Step type" }), { key: "ArrowDown", altKey: true });
  expect(scenario()).toEqual([{ type: "call", connection: "gateway-to-middle" }, { type: "process" }]);
  history(1);
  click("Undo");
  expect(stored()).toEqual({ model: explicit, layout, experiment });
});

it("removes the scenario field when deleting the last step and restores it with Undo", () => {
  render(<Editor initial={{ ...explicit, blocks: { ...explicit.blocks, gateway: { ...explicit.blocks.gateway, scenario: [{ type: "process" }] } } }} />);
  click("Delete step", step(1));
  expect(Object.hasOwn(stored().model.blocks.gateway, "scenario")).toBe(false);
  history(1);
  click("Undo");
  expect(scenario()).toEqual([{ type: "process" }]);
});

it("uses catalog initial values for optional overrides with one Undo per edit", () => {
  const catalog = structuredClone(serverCatalog) as Catalog;
  const descriptors = catalog.types.find(type => type.id === "service")!.params;
  descriptors.find(param => param.name === "processing")!.initial = { kind: "fixed", mean: "13ms" };
  descriptors.find(param => param.name === "failureRate")!.initial = "7%";
  render(<Editor initial={explicit} catalog={catalog} />);
  fireEvent.click(within(step(1)).getByRole("checkbox", { name: "Own processing time" }));
  expect(scenario()?.[0]).toEqual({ type: "process", processing: { kind: "fixed", mean: "13ms" } });
  history(1);
  fireEvent.click(within(step(1)).getByRole("checkbox", { name: "Own failure rate" }));
  expect(scenario()?.[0]).toEqual({ type: "process", processing: { kind: "fixed", mean: "13ms" }, failureRate: "7%" });
  history(2);
  const mean = within(step(1)).getByLabelText("Mean", { exact: true });
  fireEvent.change(mean, { target: { value: "2ms" } });
  fireEvent.blur(mean);
  expect(scenario()?.[0].processing).toEqual({ kind: "fixed", mean: "2ms" });
  history(3);
  click("Undo");
  expect(scenario()?.[0].processing).toEqual({ kind: "fixed", mean: "13ms" });
  fireEvent.click(within(step(1)).getByRole("checkbox", { name: "Own processing time" }));
  expect(scenario()?.[0]).toEqual({ type: "process", failureRate: "7%" });
  click("Undo");
  expect(scenario()?.[0].processing).toEqual({ kind: "fixed", mean: "13ms" });
});

it("protects an unparseable draft from structural edits", () => {
  render(<Editor initial={{ ...explicit, blocks: { ...explicit.blocks, gateway: { ...explicit.blocks.gateway, scenario: [
    { type: "process", processing: { kind: "fixed", mean: "1ms" } }, { type: "call", connection: "gateway-to-middle" },
  ] } } }} />);
  const mean = within(step(1)).getByLabelText("Mean", { exact: true });
  fireEvent.change(mean, { target: { value: "unparseable" } });
  expect(within(step(1)).getByRole<HTMLButtonElement>("button", { name: "Delete step" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add call" }).disabled).toBe(true);
  fireEvent.keyDown(mean, { key: "ArrowDown", altKey: true });
  history(0);
  expect((mean as HTMLInputElement).value).toBe("unparseable");
});

it("commits a focused process draft before a keyboard move, with separate Undo for each edit", async () => {
  render(<Editor initial={{ ...explicit, blocks: { ...explicit.blocks, gateway: { ...explicit.blocks.gateway, scenario: [
    { type: "process", processing: { kind: "fixed", mean: "1ms" } }, { type: "call", connection: "gateway-to-middle" },
  ] } } }} />);
  const mean = within(step(1)).getByLabelText("Mean", { exact: true });
  mean.focus();
  fireEvent.change(mean, { target: { value: "2ms" } });
  fireEvent.keyDown(mean, { key: "ArrowDown", altKey: true });
  await waitFor(() => expect(scenario()?.[1]).toEqual({ type: "process", processing: { kind: "fixed", mean: "2ms" } }));
  history(2);
  click("Undo");
  expect(scenario()?.[0]).toEqual({ type: "process", processing: { kind: "fixed", mean: "2ms" } });
  click("Undo");
  expect(scenario()?.[0]).toEqual({ type: "process", processing: { kind: "fixed", mean: "1ms" } });
});

it("commits a valid process field while another field has an unparseable draft", () => {
  render(<Editor initial={{ ...explicit, blocks: { ...explicit.blocks, gateway: { ...explicit.blocks.gateway, scenario: [
    { type: "process", processing: { kind: "fixed", mean: "1ms" }, failureRate: "0%" },
  ] } } }} />);
  const mean = within(step(1)).getByLabelText("Mean", { exact: true });
  fireEvent.change(mean, { target: { value: "unparseable" } });
  const failure = within(step(1)).getByLabelText("Failure rate", { exact: true });
  fireEvent.change(failure, { target: { value: "10%" } });
  fireEvent.blur(failure);
  expect(scenario()?.[0].failureRate).toBe("10%");
  fireEvent.change(mean, { target: { value: "2ms" } });
  fireEvent.blur(mean);
  expect(scenario()?.[0]).toEqual({ type: "process", processing: { kind: "fixed", mean: "2ms" }, failureRate: "10%" });
  history(2);
});

it("shows variant structure read-only", () => {
  render(<Editor initial={explicit} variantId="baseline" />);
  const type = within(step(1)).getByRole<HTMLSelectElement>("combobox", { name: "Step type" });
  expect(type.disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add call" }).disabled).toBe(true);
  fireEvent.change(type, { target: { value: "call" } });
  fireEvent.keyDown(type, { key: "ArrowDown", altKey: true });
  history(0);
  expect(within(screen.getByText("Scenario", { exact: true }).closest("details")!).getByTitle("Structure is edited on the Model page")).toBeTruthy();
});

it("keeps invalid references repairable, shows step diagnostics and focuses them from Problems", () => {
  localStorage.setItem("resilience-lab.inspector-scenario-open", "false");
  const diagnostic: Diagnostic = { code: "SCENARIO_CONNECTION", message: "Invalid outgoing connection", severity: "ERROR",
    args: { service: "gateway", connection: "missing" }, pointer: "/blocks/gateway/scenario/0/connection", path: "gateway" };
  render(<Editor initial={{ ...explicit, blocks: { ...explicit.blocks, gateway: { ...explicit.blocks.gateway,
    scenario: [{ type: "call", connection: "missing" }],
  } } }} fieldDiagnostics={new Map([["scenario.0.connection", [diagnostic]]])}
    focusField={{ path: "scenario.0.connection", request: 1 }} />);
  const connection = within(step(1)).getByRole<HTMLSelectElement>("combobox", { name: "Connection" });
  expect(connection.value).toBe("missing");
  expect(document.activeElement).toBe(connection);
  expect(step(1).querySelector(".diagnostic-code")?.textContent).toBe("SCENARIO_CONNECTION");
  fireEvent.change(connection, { target: { value: "a-call" } });
  expect(scenario()).toEqual([{ type: "call", connection: "a-call" }]);
});

it("opens the owning step for an error about a field hidden by the step type", () => {
  localStorage.setItem("resilience-lab.inspector-scenario-open", "false");
  const diagnostic: Diagnostic = { code: "SCENARIO_FIELD", message: "Field does not apply", severity: "ERROR",
    args: { field: "connection", type: "process" }, pointer: "/blocks/gateway/scenario/0/connection", path: "gateway" };
  render(<Editor initial={{ ...explicit, blocks: { ...explicit.blocks, gateway: { ...explicit.blocks.gateway,
    scenario: [{ type: "process", connection: "a-call" }],
  } } }} fieldDiagnostics={new Map([["scenario.0.connection", [diagnostic]]])}
    focusField={{ path: "scenario.0.connection", request: 1 }} />);
  expect(screen.getByText("Scenario", { exact: true }).closest("details")!.open).toBe(true);
  expect(document.activeElement).toBe(within(step(1)).getByRole("combobox", { name: "Step type" }));
  expect(step(1).querySelector(".diagnostic-code")?.textContent).toBe("SCENARIO_FIELD");
});

it("does not create calls without outgoing calls or show scenarios for non-service blocks", () => {
  const view = render(<Editor initial={explicit} selected="dependency" />);
  click("Set custom scenario");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add call" }).disabled).toBe(true);
  expect(within(step(1)).getByRole<HTMLSelectElement>("combobox", { name: "Step type" }).querySelector<HTMLOptionElement>('option[value="call"]')!.disabled).toBe(true);
  view.unmount();
  render(<Editor selected="client" />);
  expect(screen.queryByText("Scenario", { exact: true })).toBeNull();
});

it("opens scenario help without collapsing the section", () => {
  render(<Editor initial={explicit} />);
  click("More about: Scenario");
  expect(screen.getByText("Scenario", { exact: true }).closest("details")!.open).toBe(true);
  expect(screen.getByRole("tooltip").textContent).toContain("Alt+Up");
});

it("preserves request-class filters when changing step type and undoing", () => {
  const initial = structuredClone(explicit);
  Object.assign(initial.blocks.gateway.scenario![0], { classes: ["checkout"] });
  render(<Editor initial={initial} />);
  fireEvent.change(within(step(1)).getByRole("combobox", { name: "Step type" }), { target: { value: "call" } });
  expect(scenario()?.[0]).toEqual({ type: "call", connection: "a-call", classes: ["checkout"] });
  click("Undo");
  expect(stored().model).toEqual(initial);
  fireEvent.change(within(step(2)).getByRole("combobox", { name: "Step type" }), { target: { value: "process" } });
  expect(scenario()?.[1]).toEqual({ type: "process" });
});
