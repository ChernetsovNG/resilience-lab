import { useCallback, useReducer, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Catalog, Diagnostic, ModelFile } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState, setModelParam } from "../workspace/editor";
import { setVariantParam } from "../workspace/experimentCommands";
import { applyOverrides } from "../workspace/params";
import { Inspector } from "./Inspector";

const source: ModelFile = { ...model, blocks: { ...model.blocks,
  gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, replicas: 3 } },
} };
const withOverrides = (replicaOverrides: NonNullable<ModelFile["blocks"][string]["replicaOverrides"]>): ModelFile => ({
  ...source, blocks: { ...source.blocks, gateway: { ...source.blocks.gateway, replicaOverrides } },
});

function Editor({ initial = source, catalog = serverCatalog as Catalog, variantId = null, fieldDiagnostics, focusField }: {
  initial?: ModelFile; catalog?: Catalog; variantId?: string | null;
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
  const loaded = state.loaded!;
  const overrides = loaded.experiment.variants.find(variant => variant.id === variantId)?.overrides ?? {};
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <Inspector catalog={catalog} model={variantId === null ? loaded.model : applyOverrides(loaded.model, overrides, catalog)}
      experiment={loaded.experiment} selected="gateway" editable variantId={variantId} invalid={invalid.size > 0}
      overrides={overrides} onParam={(id, path, value) => dispatch({ type: "command", command: variantId === null
        ? setModelParam(id, path, value) : setVariantParam(variantId, id, path, value, catalog) })}
      onCommand={command => dispatch({ type: "command", command })} onValidity={onValidity}
      fieldDiagnostics={fieldDiagnostics} focusField={focusField} />
    <output data-testid="documents">{JSON.stringify({ model: loaded.model, layout: loaded.layout, experiment: loaded.experiment })}</output>
    <output data-testid="history">{state.past.length}</output>
  </>;
}

afterEach(() => localStorage.clear());
const stored = () => JSON.parse(screen.getByTestId("documents").textContent!) as { model: ModelFile; experiment: typeof experiment };
const overrides = () => stored().model.blocks.gateway.replicaOverrides;
const section = () => within(screen.getByText("Replica overrides", { exact: true }).closest("details")!);
const row = (number: string) => section().getByRole("row", { name: new RegExp(`^#${number}\\b`) });
const click = (name: string) => fireEvent.click(section().getByRole("button", { name }));
const history = (size: number) => expect(screen.getByTestId("history").textContent).toBe(String(size));
const edit = (field: HTMLElement, value: string) => {
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

it("adds replica #2 with catalog initial processing in one Undo entry", () => {
  const catalog = structuredClone(serverCatalog) as Catalog;
  catalog.types.find(type => type.id === "service")!.params.find(param => param.name === "processing")!.initial = { kind: "fixed", mean: "13ms" };
  render(<Editor catalog={catalog} />);
  fireEvent.change(section().getByRole("spinbutton", { name: "Replica number" }), { target: { value: "2" } });
  click("Add override");
  expect(overrides()).toEqual({ "2": { processing: { kind: "fixed", mean: "13ms" } } });
  history(1);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(stored()).toEqual({ model: source, layout, experiment });
});

it("edits and deletes a replica with one Undo per action, preserving other rows and documents", () => {
  const initial = withOverrides({ "1": { handlers: 10 }, "2": { processing: { kind: "fixed", mean: "13ms" } } });
  render(<Editor initial={initial} />);
  edit(within(row("2")).getByRole("textbox", { name: "Mean" }), "35ms");
  expect(overrides()).toEqual({ "1": { handlers: 10 }, "2": { processing: { kind: "fixed", mean: "35ms" } } });
  history(1);
  click("Remove override for replica 2");
  expect(overrides()).toEqual({ "1": { handlers: 10 } });
  history(2);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(overrides()?.["2"]).toEqual({ processing: { kind: "fixed", mean: "35ms" } });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(stored()).toEqual({ model: initial, layout, experiment });
});

it("changes a replica distribution and its dependent fields in one Undo entry", () => {
  render(<Editor initial={withOverrides({ "2": { processing: { mean: "13ms" } } })} />);
  const replica = within(row("2"));
  fireEvent.change(replica.getByRole("combobox", { name: "Distribution" }), { target: { value: "lognormal" } });
  expect(overrides()?.["2"].processing).toEqual({ kind: "lognormal", mean: "13ms", stdDev: "13ms" });
  history(1);
  fireEvent.change(replica.getByRole("combobox", { name: "Distribution" }), { target: { value: "fixed" } });
  expect(overrides()?.["2"].processing).toEqual({ kind: "fixed", mean: "13ms" });
  history(2);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(overrides()?.["2"].processing).toEqual({ kind: "lognormal", mean: "13ms", stdDev: "13ms" });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(overrides()).toEqual({ "2": { processing: { mean: "13ms" } } });
});

it("suppresses a group deviation when a replica switches to fixed", () => {
  const input = structuredClone(withOverrides({ "2": { processing: { mean: "13ms" } } }));
  input.blocks.gateway.params.processing = { kind: "lognormal", mean: "2ms", stdDev: "1ms" };
  render(<Editor initial={input} />);
  fireEvent.change(within(row("2")).getByRole("combobox", { name: "Distribution" }), { target: { value: "fixed" } });
  expect(overrides()?.["2"].processing).toEqual({ kind: "fixed", mean: "13ms", stdDev: null });
  expect(stored().model.blocks.gateway.params.processing).toEqual({ kind: "lognormal", mean: "2ms", stdDev: "1ms" });
  expect(within(row("2")).queryByRole("textbox", { name: "Standard deviation" })).toBeNull();
  history(1);
});

it("suppresses an inherited deviation when adding an exponential replica override", () => {
  const initial = structuredClone(source);
  initial.blocks.gateway.params.processing = { kind: "lognormal", mean: "2ms", stdDev: "1ms" };
  render(<Editor initial={initial} />);
  fireEvent.change(section().getByRole("spinbutton", { name: "Replica number" }), { target: { value: "2" } });
  click("Add override");
  expect(overrides()?.["2"].processing).toEqual({ kind: "exponential", mean: "10ms", stdDev: null });
  history(1);
});

it("keeps inherited processing fields absent when editing a sparse override", () => {
  render(<Editor initial={withOverrides({ "2": { processing: { mean: "13ms" } } })} />);
  const replica = within(row("2"));
  expect(replica.getByRole<HTMLSelectElement>("combobox", { name: "Distribution" }).value).toBe("fixed");
  edit(replica.getByRole("textbox", { name: "Mean" }), "35ms");
  expect(overrides()).toEqual({ "2": { processing: { mean: "35ms" } } });
  history(1);
});

it("adds a parameter from its catalog initial and removes the last field without leaving an empty row", () => {
  render(<Editor initial={withOverrides({ "2": { processing: { mean: "13ms" } } })} />);
  fireEvent.change(within(row("2")).getByRole("combobox", { name: "Add parameter for replica 2" }), { target: { value: "handlers" } });
  expect(overrides()?.["2"]).toEqual({ processing: { mean: "13ms" }, handlers: 200 });
  history(1);
  click("Use group value for Handlers in replica 2");
  expect(overrides()?.["2"]).toEqual({ processing: { mean: "13ms" } });
  history(2);
  click("Use group value for Processing time in replica 2");
  expect(Object.hasOwn(stored().model.blocks.gateway, "replicaOverrides")).toBe(false);
  history(3);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(overrides()).toEqual({ "2": { processing: { mean: "13ms" } } });
});

it("rejects duplicate, non-integer and out-of-range additions without overwriting existing values", () => {
  const initial = withOverrides({ "2": { handlers: 17 } });
  render(<Editor initial={initial} />);
  for (const value of ["2", "0", "4", "1.5"]) {
    fireEvent.change(section().getByRole("spinbutton", { name: "Replica number" }), { target: { value } });
    expect(section().getByRole<HTMLButtonElement>("button", { name: "Add override" }).disabled).toBe(true);
  }
  history(0);
  expect(stored()).toEqual({ model: initial, layout, experiment });
});

it("shows out-of-range REPLICA_INDEX diagnostics and keeps the row removable", () => {
  render(<Editor initial={withOverrides({ "4": { handlers: 17 } })} />);
  expect(row("4").querySelector(".diagnostic-code")?.textContent).toBe("REPLICA_INDEX");
  expect(row("4").getAttribute("aria-invalid")).toBe("true");
  click("Remove override for replica 4");
  expect(overrides()).toBeUndefined();
  history(1);
});

it("preserves unparseable drafts by disabling structural actions", () => {
  render(<Editor initial={withOverrides({ "2": { processing: { mean: "13ms" } } })} />);
  fireEvent.change(within(row("2")).getByRole("textbox", { name: "Mean" }), { target: { value: "unparseable" } });
  expect(section().getByRole<HTMLButtonElement>("button", { name: "Remove override for replica 2" }).disabled).toBe(true);
  expect(section().getByRole<HTMLButtonElement>("button", { name: "Add override" }).disabled).toBe(true);
  history(0);
});

it("keeps variant replica structure read-only while replica count edits create variant overrides", () => {
  const initial = withOverrides({ "2": { processing: { mean: "13ms" } } });
  render(<Editor initial={initial} variantId="baseline" />);
  const mean = within(row("2")).getByRole<HTMLInputElement>("textbox", { name: "Mean" });
  expect(mean.readOnly).toBe(true);
  edit(mean, "35ms");
  expect(section().getByRole<HTMLButtonElement>("button", { name: "Remove override for replica 2" }).disabled).toBe(true);
  expect(screen.getAllByTitle("Structure is edited on the Model page").length).toBeGreaterThan(0);
  history(0);
  edit(screen.getByRole("textbox", { name: "Replicas" }), "4");
  expect(stored().experiment.variants[0].overrides["gateway.replicas"]).toBe(4);
  expect(stored().model).toEqual(initial);
  history(1);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(stored()).toEqual({ model: initial, layout, experiment });
});

it("opens the replica section and focuses the diagnostic field from Problems", () => {
  localStorage.setItem("resilience-lab.inspector-replicaOverrides-open", "false");
  const diagnostic: Diagnostic = { code: "PARAM_RANGE", message: "Invalid replica parameter", severity: "ERROR",
    pointer: "/blocks/gateway/replicaOverrides/2/handlers", path: "gateway#2" };
  render(<Editor initial={withOverrides({ "2": { handlers: 0 } })}
    fieldDiagnostics={new Map([["replicaOverrides.2.handlers", [diagnostic]]])}
    focusField={{ path: "replicaOverrides.2.handlers", request: 1 }} />);
  const field = within(row("2")).getByRole("textbox", { name: "Handlers" });
  expect(document.activeElement).toBe(field);
  expect(row("2").querySelector(".diagnostic-code")?.textContent).toBe("PARAM_RANGE");
});
