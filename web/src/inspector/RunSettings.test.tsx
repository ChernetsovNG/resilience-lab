import { useReducer } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { dirtyDocuments, editorReducer, initialEditorState } from "../workspace/editor";
import { RunSettings } from "./RunSettings";
import { setLanguage } from "../i18n";

afterEach(() => { vi.restoreAllMocks(); setLanguage("en"); });

function Settings({ editable = true, source = experiment } = {}) {
  const documents = { model, layout, experiment: source };
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
  { warmup: "10s", measurement: "60s", from: "40000ms", to: "55000ms" },
  { warmup: "1min", measurement: "120s", from: "120000ms", to: "150000ms" },
  { warmup: "0ms", measurement: "1s", from: "500ms", to: "750ms" },
])("adds a fault inside measurement with $warmup warmup and $measurement measurement", ({ warmup, measurement, from, to }) => {
  render(<Settings source={{ ...experiment, faults: [], execution: { ...experiment.execution, warmup, measurement } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add fault" }));
  expect((document.querySelector('[data-inspector-field="faults.0.from"] input') as HTMLInputElement).value).toBe(from);
  expect((document.querySelector('[data-inspector-field="faults.0.to"] input') as HTMLInputElement).value).toBe(to);
});

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

it.each([
  { language: "en", prefix: "More about: ", fields: [
    ["Replications", "Start with 10"], ["Warm-up", "excluded from results"],
    ["Measurement", "Start with 60s"], ["Series window", "measurement / 100"],
    ["Seed", "same result"], ["Real-time limit", "real time"],
  ] },
  { language: "ru", prefix: "Подробнее: ", fields: [
    ["Повторения", "Начните с 10"], ["Разогрев", "не входит в результаты"],
    ["Измерение", "Начните с 60s"], ["Окно временных рядов", "измерение / 100"],
    ["Начальное значение генератора", "тот же результат"], ["Ограничение реального времени", "реального времени"],
  ] },
] as const)("explains all six run fields with associated help in $language", ({ language, prefix, fields }) => {
  setLanguage(language);
  render(<Settings />);
  expect(screen.getAllByRole("heading").map(heading => heading.textContent)).toEqual(language === "ru"
    ? ["Прогон", "Отказы", "Перебор параметров"] : ["Run", "Faults", "Parameter sweep"]);
  for (const [label, description] of fields) {
    const input = screen.getByRole("textbox", { name: label });
    fireEvent.click(screen.getByRole("button", { name: prefix + label }));
    const tooltip = screen.getByRole("tooltip");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(tooltip.id);
    expect(tooltip.textContent).toContain(description);
    fireEvent.keyDown(window, { key: "Escape" });
  }
});
