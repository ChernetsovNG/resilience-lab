import { useReducer } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState } from "../workspace/editor";
import { RunSettings } from "./RunSettings";

const gridCatalog = structuredClone(catalog);
for (const param of gridCatalog.types.find((type) => type.id === "call")!.params) {
  if (param.name === "timeout" || param.name === "attempts") param.sweepable = true;
}
gridCatalog.types.find((type) => type.id === "service")!.params.find((param) => param.name === "processing")!
  .fields.find((param) => param.name === "mean")!.sweepable = true;

function Settings() {
  const documents = { model, layout, experiment };
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...documents, saved: documents, experimentPath: "test.experiment.json", modelPath: "test.model.json",
    layoutPath: "test.layout.json", versions: { model: "m", layout: "l", experiment: "e" },
  } }));
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <button onClick={() => dispatch({ type: "redo" })}>Redo</button>
    <RunSettings catalog={gridCatalog} model={model} experiment={state.loaded!.experiment} editable invalid={false}
      onCommand={(command) => dispatch({ type: "command", command })} onValidity={vi.fn()} />
    <output data-testid="grid-document">{JSON.stringify(state.loaded!.experiment.grid)}</output>
  </>;
}

it("edits catalog paths and values in shared settings with undo/redo and a two-axis limit", () => {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Add grid axis" }));
  const path = screen.getByLabelText("Axis 1 parameter");
  expect(screen.getByRole("option", { name: /gateway.processing.mean/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /processing.kind/ })).toBeNull();
  fireEvent.change(path, { target: { value: "gateway-to-middle.timeout" } });
  fireEvent.click(screen.getByRole("button", { name: "Add value to axis 1" }));
  const value = screen.getByLabelText("Axis 1 value 2");
  fireEvent.change(value, { target: { value: "0.04s" } });
  fireEvent.blur(value);
  expect(screen.getByTestId("grid-document").textContent).toBe('[{"path":"gateway-to-middle.timeout","values":["80ms","0.04s"]}]');
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect((screen.getByLabelText("Axis 1 value 2") as HTMLInputElement).value).toBe("80ms");
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
