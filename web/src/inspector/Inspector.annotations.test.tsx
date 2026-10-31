import { fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState, type EditorDocuments } from "../workspace/editor";
import { Inspector } from "./Inspector";

const original = "  Initial explanation\nSource: https://example.org/  ";
const edited = "  Новое пояснение\nДопущение: 120/s  ";
const annotated = (): EditorDocuments => ({ layout, model: {
  ...model, description: original, notes: original,
  blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, description: original, notes: original } },
  connections: model.connections.map(connection => ({ ...connection, description: original, notes: original })),
}, experiment: { ...experiment, description: original, notes: original,
  variants: experiment.variants.map(variant => ({ ...variant, description: original })),
} });

type Target = "block" | "connection" | "model" | "experiment" | "variant";
function annotation(documents: EditorDocuments, target: Target): { description?: string | null; notes?: string | null } {
  if (target === "block") return documents.model.blocks.gateway;
  if (target === "connection") return documents.model.connections[1];
  if (target === "variant") return documents.experiment.variants[0];
  return documents[target];
}

function renderEditor(target: Target, variantPage = false) {
  const documents = annotated();
  let current = documents;
  function Editor() {
    const [state, dispatch] = useReducer(editorReducer, { ...initialEditorState, loaded: {
      ...documents, saved: documents, experimentPath: "e.experiment.json", modelPath: "m.model.json", layoutPath: "l.layout.json",
      versions: { model: "m", experiment: "e", layout: "l" },
    } });
    current = state.loaded!;
    return <>
      <Inspector catalog={catalog} model={state.loaded!.model} experiment={state.loaded!.experiment}
        selected={target === "block" ? "gateway" : target === "connection" ? "gateway-to-middle" : null}
        target={target === "variant" ? "variant" : target === "block" || target === "connection" ? "element" : "experiment"}
        variantId={target === "variant" || variantPage ? "baseline" : null}
        editable overrides={{}} onParam={vi.fn()} onValidity={vi.fn()}
        onCommand={command => dispatch({ type: "command", command })} />
      <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
      <output data-testid="history-length">{state.past.length}</output>
    </>;
  }
  render(<Editor />);
  if (target === "model" || target === "experiment") fireEvent.click(screen.getByText("Descriptions and notes"));
  const scope = target === "model" || target === "experiment"
    ? within(screen.getByRole("group", { name: target === "model" ? "Model" : "Experiment" })) : screen;
  return { documents, current: () => current, scope };
}

const cases = (["block", "connection", "model", "experiment"] as const)
  .flatMap(target => (["description", "notes"] as const).map(field => ({ target, field })));

it.each([...cases, { target: "variant" as const, field: "description" as const }])(
  "edits, clears and undoes $target $field without changing other document fields", ({ target, field }) => {
    const { documents, current, scope } = renderEditor(target);
    const input = () => scope.getByRole<HTMLTextAreaElement>("textbox", { name: field === "description" ? "Description" : "Notes" });
    expect(input().value).toBe(original);
    fireEvent.change(input(), { target: { value: edited } });
    expect(annotation(current(), target)[field]).toBe(original);
    fireEvent.blur(input());
    const expected = structuredClone(documents);
    Object.assign(annotation(expected, target), { [field]: edited });
    expect({ model: current().model, experiment: current().experiment, layout: current().layout }).toEqual(expected);
    expect(screen.getByTestId("history-length").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(input().value).toBe(original);
    expect(screen.getByTestId("history-length").textContent).toBe("0");
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.blur(input());
    expect(annotation(current(), target)).not.toHaveProperty(field);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(input().value).toBe(original);
  },
);

it.each(["block", "connection", "model"] as const)("keeps $target annotations read-only on variant pages", target => {
  const { current, documents, scope } = renderEditor(target, true);
  for (const label of ["Description", "Notes"]) {
    const input = scope.getByRole<HTMLTextAreaElement>("textbox", { name: label });
    expect(input.readOnly).toBe(true);
    fireEvent.change(input, { target: { value: edited } });
    fireEvent.blur(input);
  }
  expect(current().model).toEqual(documents.model);
  expect(screen.getByTestId("history-length").textContent).toBe("0");
});
