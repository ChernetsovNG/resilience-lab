import { useReducer } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { dirtyDocuments, editorReducer, initialEditorState } from "../workspace/editor";
import { RunSettings } from "./RunSettings";

afterEach(() => vi.restoreAllMocks());

function Settings({ editable = true } = {}) {
  const documents = { model, layout, experiment };
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...documents, saved: documents, experimentPath: "test.experiment.json", modelPath: "test.model.json",
    layoutPath: "test.layout.json", versions: { model: "m", layout: "l", experiment: "e" },
  } }));
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <RunSettings catalog={catalog} model={model} experiment={state.loaded!.experiment} editable={editable} invalid={false}
      onCommand={(command) => dispatch({ type: "command", command })} onValidity={vi.fn()} />
    <output data-testid="history-size">{state.past.length}</output>
    <output data-testid="dirty">{String(dirtyDocuments(state.loaded).experiment)}</output>
  </>;
}

it.each([
  { words: [0, 0], expected: 0 },
  { words: [0xffffffff, 0xffffffff], expected: 9007199254740991 },
  { words: [0xffe00000, 0], expected: 0 },
  { words: [1, 1], expected: 4294967297 },
  { words: [0x100000, 0], expected: 4503599627370496 },
])("uses random words $words for safe integer seed $expected with one undoable edit", ({ words, expected }) => {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(array => {
    (array as Uint32Array).set(words);
    return array;
  });
  render(<Settings />);
  const seed = screen.getByLabelText("Seed") as HTMLInputElement;
  const previous = seed.value;
  const random = screen.getByRole("button", { name: "Random seed" });
  expect(random.getAttribute("title")).toBe("Random seed");
  fireEvent.click(random);

  expect(seed.value).toBe(String(expected));
  expect(Number.isSafeInteger(Number(seed.value))).toBe(true);
  expect(Number(seed.value)).toBeGreaterThanOrEqual(0);
  expect(screen.getByTestId("history-size").textContent).toBe("1");
  expect(screen.getByTestId("dirty").textContent).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(seed.value).toBe(previous);
  expect(screen.getByTestId("history-size").textContent).toBe("0");
  expect(screen.getByTestId("dirty").textContent).toBe("false");
});

it("disables random seed when run settings are read-only", () => {
  render(<Settings editable={false} />);
  const seed = screen.getByLabelText("Seed") as HTMLInputElement;
  const previous = seed.value;
  const random = screen.getByRole("button", { name: "Random seed" }) as HTMLButtonElement;
  expect(random.disabled).toBe(true);
  fireEvent.click(random);
  expect(seed.value).toBe(previous);
  expect(screen.getByTestId("history-size").textContent).toBe("0");
});
