import { useCallback, useReducer, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Catalog, Diagnostic, ExperimentFile, ModelFile } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState, type EditorDocuments } from "../workspace/editor";
import { applyOverrides, withParam } from "../workspace/params";
import { ExperimentCourse } from "../experiment/ExperimentCourse";
import { Inspector } from "./Inspector";

const ramp = { points: [{ time: "0s", rate: "10/s" }, { time: "30s", rate: "100/s" }] };
const source: ModelFile = { ...model, blocks: { ...model.blocks,
  client: { ...model.blocks.client, params: { ...model.blocks.client.params, load: ramp } },
} };
const run: ExperimentFile = { ...experiment, execution: { ...experiment.execution, warmup: "5s", measurement: "25s" } };

function Editor({ initial = source, initialExperiment = run, variantId = null, catalog = serverCatalog as Catalog,
  fieldDiagnostics, focusField, editable = true }: {
  initial?: ModelFile; initialExperiment?: ExperimentFile; variantId?: string | null; catalog?: Catalog;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>; focusField?: { path: string; request: number }; editable?: boolean;
}) {
  const documents = { model: initial, layout, experiment: initialExperiment };
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
  const effective = variantId === null ? loaded.model : applyOverrides(loaded.model, overrides, catalog);
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <button onClick={() => dispatch({ type: "redo" })}>Redo</button>
    <Inspector catalog={catalog} model={effective} experiment={loaded.experiment} selected="client"
      editable={editable} variantId={variantId} invalid={invalid.size > 0} overrides={overrides}
      onParam={(id, name, value) => dispatch({ type: "command",
        command: docs => ({ ...docs, model: withParam(docs.model, id, name, value) }) })}
      onCommand={command => dispatch({ type: "command", command })} onValidity={onValidity}
      fieldDiagnostics={fieldDiagnostics} focusField={focusField} />
    <ExperimentCourse model={effective} experiment={loaded.experiment} catalog={catalog} onFault={() => {}} />
    <output data-testid="documents">{JSON.stringify({ model: loaded.model, layout: loaded.layout, experiment: loaded.experiment })}</output>
    <output data-testid="history">{state.past.length}</output>
  </>;
}

const stored = () => JSON.parse(screen.getByTestId("documents").textContent!) as EditorDocuments;
const load = () => stored().model.blocks.client.params.load;
const table = () => screen.getByRole("table", { name: "Load points" });
const rows = () => within(table()).getAllByRole("row").slice(1);
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const history = (size: number) => expect(screen.getByTestId("history").textContent).toBe(String(size));
function commit(row: number, label: string, value: string) {
  const field = within(rows()[row]).getByLabelText(label, { exact: true });
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}
afterEach(() => localStorage.clear());

it("adds a later point with the last rate and undoes the complete document in one step", () => {
  render(<Editor />);
  click("Add point");
  expect(load()).toEqual({ points: [...ramp.points, { time: "31s", rate: "100/s" }] });
  history(1);
  click("Undo");
  expect(stored()).toEqual({ model: source, layout, experiment: run });
  click("Redo");
  expect(rows()).toHaveLength(3);
});

it("commits a point once on Enter and blur, preserves other fields and updates both curves immediately", () => {
  render(<Editor />);
  const intensity = within(rows()[1]).getByLabelText("Intensity", { exact: true });
  fireEvent.change(intensity, { target: { value: "80/s" } });
  fireEvent.keyDown(intensity, { key: "Enter" });
  fireEvent.blur(intensity);
  expect(load()).toEqual({ points: [{ time: "0s", rate: "10/s" }, { time: "30s", rate: "80/s" }] });
  history(1);
  const mini = screen.getByRole("img", { name: "client: arrival intensity" });
  expect(mini.querySelector("polyline")?.getAttribute("points")).toBe("0,72.5 300,20");
  expect(mini.querySelector('[data-phase="warmup"]')?.getAttribute("width")).toBe("50");
  expect(mini.querySelector('[data-phase="measurement"]')?.getAttribute("width")).toBe("250");
  expect(screen.getByRole("region", { name: "Experiment course" }).querySelector("polyline")?.getAttribute("points")).toBe("0,59 1000,24");
  expect(screen.getByRole("button", { name: "Experiment course" }).textContent).toContain("from 10 RPS to 80 RPS");
  click("Undo");
  expect(load()).toEqual(ramp);
});

it("deletes and restores a point with one Undo and repairs an empty profile with catalog initials", () => {
  render(<Editor />);
  click("Delete point 2");
  expect(load()).toEqual({ points: [ramp.points[0]] });
  history(1);
  click("Undo");
  expect(load()).toEqual(ramp);
  click("Delete point 2");
  click("Delete point 1");
  expect(load()).toEqual({ points: [] });
  click("Add point");
  expect(load()).toEqual({ points: [{ time: "0s", rate: "10/s" }] });
});

it("uses catalog point initials to repair missing load without materializing defaults on read", () => {
  const catalog = structuredClone(serverCatalog) as Catalog;
  const fields = catalog.types.find(type => type.id === "client")!.params.find(param => param.name === "load")!
    .fields.find(field => field.name === "points")!.fields;
  fields.find(field => field.name === "time")!.initial = "2s";
  fields.find(field => field.name === "rate")!.initial = "7/s";
  const initial = withParam(source, "client", "load", undefined);
  render(<Editor initial={initial} catalog={catalog} />);
  expect(load()).toBeUndefined();
  history(0);
  click("Add point");
  expect(load()).toEqual({ points: [{ time: "2s", rate: "7/s" }] });
  click("Undo");
  expect(stored()).toEqual({ model: initial, layout, experiment: run });
});

it("replaces a variant profile as a whole, preserves the model and resets with one Undo", () => {
  const initialExperiment = { ...run, variants: run.variants.map(variant => ({ ...variant,
    overrides: variant.id === "baseline" ? { "client.load.points": [{ time: "0s", rate: "5/s" }] } : variant.overrides,
  })) };
  render(<Editor variantId="baseline" initialExperiment={initialExperiment} />);
  commit(0, "Intensity", "20/s");
  expect(stored().model).toEqual(source);
  expect(stored().experiment.variants[0].overrides).toEqual({ "client.load": { points: [{ time: "0s", rate: "20/s" }] } });
  history(1);
  click("Reset Load profile");
  expect(stored().experiment.variants[0].overrides).toEqual({});
  expect(rows()).toHaveLength(2);
  history(2);
  click("Undo");
  expect(stored().experiment.variants[0].overrides).toEqual({ "client.load": { points: [{ time: "0s", rate: "20/s" }] } });
  click("Undo");
  expect(stored()).toEqual({ model: source, layout, experiment: initialExperiment });
});

it("shows core time-order diagnostics on the row and opens it from Problems", () => {
  localStorage.setItem("resilience-lab.inspector-load-open", "false");
  const diagnostic: Diagnostic = { code: "LOAD_POINT_ORDER", message: "Load point times must be strictly increasing", severity: "ERROR",
    pointer: "/blocks/client/params/load/points/1/time", path: "client" };
  render(<Editor initial={withParam(source, "client", "load", { points: [ramp.points[0], { time: "0s", rate: "100/s" }] })}
    fieldDiagnostics={new Map([["load.points.1.time", [diagnostic]]])} focusField={{ path: "load.points.1.time", request: 1 }} />);
  expect(rows()[1].querySelector(".diagnostic-code")?.textContent).toBe("LOAD_POINT_ORDER");
  const time = within(rows()[1]).getByLabelText("Time", { exact: true });
  expect(document.activeElement).toBe(time);
  expect(time.getAttribute("aria-invalid")).toBe("true");
  commit(1, "Time", "30s");
  expect(load()).toEqual(ramp);
  history(1);
});

it("protects an unparseable draft from deleting or adding points while another field remains editable", () => {
  render(<Editor />);
  const time = within(rows()[0]).getByLabelText("Time", { exact: true });
  fireEvent.change(time, { target: { value: "unknown" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add point" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Delete point 1" }).disabled).toBe(true);
  commit(1, "Intensity", "80/s");
  expect(load()).toEqual({ points: [ramp.points[0], { time: "30s", rate: "80/s" }] });
  expect((time as HTMLInputElement).value).toBe("unknown");
  history(1);
});

it("keeps the point table read-only while workspace editing is unavailable", () => {
  render(<Editor editable={false} />);
  expect(within(rows()[0]).getByRole<HTMLInputElement>("textbox", { name: "Time" }).readOnly).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add point" }).disabled).toBe(true);
  history(0);
});

it("labels a zero-intensity profile as zero rather than its nonzero plotting scale", () => {
  render(<Editor initial={withParam(source, "client", "load", { points: [{ time: "0s", rate: "0/s" }] })} />);
  const plot = screen.getByRole("img", { name: "client: arrival intensity" });
  expect(plot.querySelector("text")?.textContent).toBe("0 RPS");
  expect(plot.querySelector("polyline")?.getAttribute("points")).toBe("0,80 300,80");
});

it("creates, renames, reorders and removes request types as single undoable edits", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("radio", { name: "Several request types" }));
  expect(stored().model.blocks.client.params.load).toBeUndefined();
  expect(stored().model.blocks.client.params.classes).toEqual([{ id: "request-1", load: ramp }]);
  history(1);
  click("Add request type");
  const ids = screen.getAllByLabelText("Request type ID");
  fireEvent.change(ids[0], { target: { value: "status" } });
  fireEvent.blur(ids[0]);
  fireEvent.change(screen.getAllByLabelText("Request type ID")[1], { target: { value: "checkout" } });
  fireEvent.blur(screen.getAllByLabelText("Request type ID")[1]);
  history(4);
  click("Move checkout up");
  expect((stored().model.blocks.client.params.classes as { id: string }[]).map(type => type.id)).toEqual(["checkout", "status"]);
  click("Delete checkout");
  history(6);
  click("Undo");
  expect(screen.getAllByRole("table", { name: "Load points" })).toHaveLength(2);
  const course = screen.getByRole("region", { name: "Experiment course" });
  expect(course.querySelectorAll(".course-load")).toHaveLength(3);
  expect(course.textContent).toContain("client · checkout");
  expect(course.textContent).toContain("client · total");
  fireEvent.click(screen.getByRole("radio", { name: "One profile" }));
  expect(stored().model.blocks.client.params.classes).toBeUndefined();
  expect(load()).toEqual({ points: [{ time: "0ms", rate: "20/s" }, { time: "30000ms", rate: "200/s" }] });
  click("Undo");
  expect(screen.getAllByLabelText("Request type ID")).toHaveLength(2);
});

it("keeps duplicate and reserved identifiers at their fields without overwriting a type", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("radio", { name: "Several request types" }));
  click("Add request type");
  const id = screen.getAllByLabelText("Request type ID")[1];
  fireEvent.change(id, { target: { value: "request-1" } });
  fireEvent.blur(id);
  expect(id.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("already used");
  history(2);
  fireEvent.change(id, { target: { value: "default" } });
  expect(screen.getByRole("alert").textContent).toContain("reserved");
  fireEvent.keyDown(id, { key: "Escape" });
  expect((id as HTMLInputElement).value).toBe("request-2");
});

it("edits a request type profile on a variant as one whole-list override and resets the mode", () => {
  render(<Editor variantId="baseline" />);
  fireEvent.click(screen.getByRole("radio", { name: "Several request types" }));
  const intensity = within(screen.getAllByRole("table", { name: "Load points" })[0]).getAllByLabelText("Intensity")[0];
  fireEvent.change(intensity, { target: { value: "20/s" } });
  fireEvent.blur(intensity);
  expect(stored().model).toEqual(source);
  const overrides = stored().experiment.variants[0].overrides;
  expect(Object.keys(overrides).sort()).toEqual(["client.classes", "client.load"]);
  expect((overrides["client.classes"] as { load: typeof ramp }[])[0].load.points[0].rate).toBe("20/s");
  click("Reset client load");
  expect(stored().experiment.variants[0].overrides).toEqual({});
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "One profile" }).checked).toBe(true);
  click("Undo");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Several request types" }).checked).toBe(true);
});

it("reports rename conflicts in another variant at the identifier draft", () => {
  const initial = withParam(withParam(source, "client", "load", undefined), "client", "classes", [{ id: "checkout", load: ramp }]);
  const initialExperiment = { ...run, variants: [{ id: "baseline", overrides: { "client.classes": [
    { id: "checkout", load: ramp }, { id: "order", load: ramp },
  ] } }] };
  render(<Editor initial={initial} initialExperiment={initialExperiment} />);
  const id = screen.getByLabelText("Request type ID");
  fireEvent.change(id, { target: { value: "order" } });
  fireEvent.blur(id);
  expect(id.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("variant");
  expect(stored().model).toEqual(initial);
  history(0);
});

it("opens a malformed request type profile from a diagnostic on the whole load object", () => {
  localStorage.setItem("resilience-lab.inspector-load-open", "false");
  const initial = withParam(withParam(source, "client", "load", undefined), "client", "classes", [{ id: "checkout", load: "bad" }]);
  const diagnostic: Diagnostic = { code: "PARAM_TYPE", message: "Expected object", severity: "ERROR", path: "client" };
  render(<Editor initial={initial} fieldDiagnostics={new Map([["classes.0.load", [diagnostic]]])}
    focusField={{ path: "classes.0.load", request: 1 }} />);
  expect(screen.getByRole("table", { name: "Load points" }).closest("details")!.open).toBe(true);
  expect(screen.getByText("PARAM_TYPE")).toBeTruthy();
});

it("shows malformed imported request types before explicitly replacing them with one undoable action", () => {
  const raw = { unexpected: "preserve-me" };
  const initial = withParam(withParam(source, "client", "load", undefined), "client", "classes", raw);
  render(<Editor initial={initial} />);
  expect(screen.getByLabelText("Invalid request types").textContent).toContain("preserve-me");
  click("Replace invalid request types");
  expect(screen.getByLabelText("Request type ID")).toBeTruthy();
  history(1);
  click("Undo");
  expect(stored().model.blocks.client.params.classes).toEqual(raw);
});

it("repairs an imported primitive request type by naming it, with one Undo", () => {
  const initial = withParam(withParam(source, "client", "load", undefined), "client", "classes", [42]);
  render(<Editor initial={initial} />);
  expect(screen.getByLabelText("Invalid request types").textContent).toBe("42");
  const id = screen.getByLabelText("Request type ID");
  fireEvent.change(id, { target: { value: "checkout" } });
  fireEvent.blur(id);
  expect(stored().model.blocks.client.params.classes).toEqual([{ id: "checkout", load: { points: [{ time: "0s", rate: "10/s" }] } }]);
  history(1);
  click("Undo");
  expect(stored().model).toEqual(initial);
});
