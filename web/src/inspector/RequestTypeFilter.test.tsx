import { useReducer } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Catalog, Diagnostic, ModelFile } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState } from "../workspace/editor";
import { Inspector } from "./Inspector";

function filteredModel(): ModelFile {
  const initial = structuredClone(model);
  delete initial.blocks.client.params.load;
  initial.blocks.client.params.classes = ["status", "checkout"].map(id => ({ id, load: { points: [{ time: "0s", rate: "20/s" }] } }));
  initial.blocks.gateway.scenario = [{ type: "process" }, { type: "call", connection: "gateway-to-middle" }];
  initial.blocks.middle = { type: "router", params: { policy: "roundRobin" } };
  initial.connections.find(edge => edge.id === "middle-to-dependency")!.type = "route";
  return initial;
}

function Editor({ initial = filteredModel(), selected = "gateway", variantId = null, fieldDiagnostics, focusField }: {
  initial?: ModelFile; selected?: string; variantId?: string | null;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>; focusField?: { path: string; request: number };
}) {
  const documents = { model: initial, layout, experiment };
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...documents, saved: documents, experimentPath: "test.experiment.json", modelPath: "test.model.json",
    layoutPath: "test.layout.json", versions: { model: "m", layout: "l", experiment: "e" },
  } }));
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <Inspector catalog={serverCatalog as Catalog} model={state.loaded!.model} experiment={experiment} selected={selected}
      editable variantId={variantId} overrides={{}} onParam={vi.fn()} onValidity={vi.fn()}
      onCommand={command => dispatch({ type: "command", command })} fieldDiagnostics={fieldDiagnostics} focusField={focusField} />
    <output data-testid="model">{JSON.stringify(state.loaded!.model)}</output>
    <output data-testid="history">{state.past.length}</output>
  </>;
}

const stored = () => JSON.parse(screen.getByTestId("model").textContent!) as ModelFile;
const route = () => stored().connections.find(edge => edge.id === "middle-to-dependency")!;
const field = (index: number | null) => index === null
  ? screen.getByRole("group", { name: "Route to dependency" })
  : within(screen.getByRole("group", { name: `Step ${index + 1}` })).getByRole("group", { name: "Execute for" });

it.each([0, 1, null])("edits the request type filter for step/route %s in single Undo entries and removes an empty filter", index => {
  render(<Editor selected={index === null ? "middle-to-dependency" : "gateway"} />);
  const target = () => index === null ? route() : stored().blocks.gateway.scenario![index];
  const checkbox = (id: string) => within(field(index)).getByRole("checkbox", { name: id });
  expect(field(index).textContent).toContain("All request types");
  fireEvent.click(checkbox("checkout"));
  expect(target().classes).toEqual(["checkout"]);
  expect(screen.getByTestId("history").textContent).toBe("1");
  fireEvent.click(checkbox("status"));
  expect(target().classes).toEqual(["checkout", "status"]);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(target().classes).toEqual(["checkout"]);
  fireEvent.click(checkbox("checkout"));
  expect(Object.hasOwn(target(), "classes")).toBe(false);
  expect(route().params).not.toHaveProperty("classes");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(target().classes).toEqual(["checkout"]);
});

it("combines all clients' request types, deduplicates IDs and includes implicit default", () => {
  const initial = filteredModel();
  initial.blocks.partner = { type: "client", params: { load: { points: [{ time: "0s", rate: "1/s" }] } } };
  initial.blocks.other = { type: "client", params: { classes: [{ id: "status" }, { id: "read" }] } };
  render(<Editor initial={initial} />);
  expect(within(field(0)).getAllByRole("checkbox").map(input => input.closest("label")!.textContent).sort())
    .toEqual(["checkout", "default", "read", "status"]);
});

it.each([0, 1, null])("shows structural filters read-only on variant pages for step/route %s", index => {
  const initial = filteredModel();
  if (index === null) initial.connections.find(edge => edge.type === "route")!.classes = ["status"];
  else initial.blocks.gateway.scenario![index].classes = ["status"];
  render(<Editor initial={initial} selected={index === null ? "middle-to-dependency" : "gateway"} variantId="baseline" />);
  const checkbox = within(field(index)).getByRole<HTMLInputElement>("checkbox", { name: "status" });
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(true);
  fireEvent.click(checkbox);
  expect(stored()).toEqual(initial);
  expect(screen.getByTestId("history").textContent).toBe("0");
  expect(field(index).title).toBe("Structure is edited on the Model page");
});

it("keeps a removed request type selected and repairable at the compiler's indexed route field", () => {
  const initial = filteredModel();
  initial.connections.find(edge => edge.type === "route")!.classes = ["removed"];
  const finding: Diagnostic = { code: "CLASS_UNKNOWN", severity: "ERROR", message: "Unknown request type",
    args: { id: "removed" }, document: "test.model.json", pointer: "/connections/3/classes/0", path: "middle-to-dependency" };
  render(<Editor initial={initial} selected="middle-to-dependency" fieldDiagnostics={new Map([["classes.0", [finding]]])}
    focusField={{ path: "classes.0", request: 1 }} />);
  const checkbox = within(field(null)).getByRole<HTMLInputElement>("checkbox", { name: "removed" });
  expect(checkbox.checked).toBe(true);
  expect(field(null).getAttribute("aria-invalid")).toBe("true");
  expect(field(null).querySelector(".diagnostic-code")?.textContent).toBe("CLASS_UNKNOWN");
  expect(document.activeElement).toBe(checkbox);
  fireEvent.click(checkbox);
  expect(Object.hasOwn(route(), "classes")).toBe(false);
});

it("keeps the previous interface when clients and steps have no request type filters", () => {
  render(<Editor initial={model} />);
  expect(screen.queryByRole("group", { name: "Execute for" })).toBeNull();
});
