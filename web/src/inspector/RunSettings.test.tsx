import { useReducer } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { dirtyDocuments, editorReducer, initialEditorState } from "../workspace/editor";
import { RunSettings } from "./RunSettings";
import { setLanguage } from "../i18n";
import serverCatalog from "../test/catalog.json";
import type { Catalog, ModelFile } from "../api/apiTypes";

afterEach(() => { vi.restoreAllMocks(); setLanguage("en"); });

function Settings({ editable = true, source = experiment, sourceModel = model, sourceCatalog = catalog } = {}) {
  const documents = { model: sourceModel, layout, experiment: source };
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...documents, saved: documents, experimentPath: "test.experiment.json", modelPath: "test.model.json",
    layoutPath: "test.layout.json", versions: { model: "m", layout: "l", experiment: "e" },
  } }));
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <button onClick={() => dispatch({ type: "redo" })}>Redo</button>
    <RunSettings catalog={sourceCatalog} model={sourceModel} experiment={state.loaded!.experiment} editable={editable} invalid={false}
      onCommand={(command) => dispatch({ type: "command", command })} onValidity={vi.fn()} />
    <output data-testid="history-size">{state.past.length}</output>
    <output data-testid="dirty">{String(dirtyDocuments(state.loaded).experiment)}</output>
    <output data-testid="fault-document">{JSON.stringify(state.loaded!.experiment.faults)}</output>
  </>;
}

it.each([
  { warmup: "10s", measurement: "60s", from: "40s", to: "55s" },
  { warmup: "1min", measurement: "120s", from: "2min", to: "150s" },
  { warmup: "0ms", measurement: "1s", from: "500ms", to: "750ms" },
])("adds a fault inside measurement with $warmup warmup and $measurement measurement", ({ warmup, measurement, from, to }) => {
  render(<Settings source={{ ...experiment, faults: [], execution: { ...experiment.execution, warmup, measurement } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add fault" }));
  expect((document.querySelector('[data-inspector-field="faults.0.from"] input') as HTMLInputElement).value).toBe(from);
  expect((document.querySelector('[data-inspector-field="faults.0.to"] input') as HTMLInputElement).value).toBe(to);
});

it.each([
  ["errors", { failureRate: "50%" }],
  ["unavailable", {}],
  ["blackhole", {}],
  ["capacityLoss", { capacity: 2 }],
] as const)("replaces slowdown fields with %s in one undoable edit", (kind, fields) => {
  const initialCatalog = structuredClone(serverCatalog) as Catalog;
  initialCatalog.types.find(type => type.id === "service")!.params.find(param => param.name === "failureRate")!.initial = "25%";
  const fault = { target: "gateway", kind: "slowdown", from: "20s", to: "30s", multiplier: 8, delay: "300ms" };
  render(<Settings sourceCatalog={initialCatalog} source={{ ...experiment, faults: [fault] }} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Fault kind" }), { target: { value: kind } });
  expect(JSON.parse(screen.getByTestId("fault-document").textContent!)).toEqual([{ target: "gateway", from: "20s", to: "30s", kind, ...fields }]);
  expect(screen.getByTestId("history-size").textContent).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(JSON.parse(screen.getByTestId("fault-document").textContent!)).toEqual([fault]);
  expect(screen.getByTestId("history-size").textContent).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(JSON.parse(screen.getByTestId("fault-document").textContent!)[0]).toEqual({ target: "gateway", from: "20s", to: "30s", kind, ...fields });
});

it.each([1, 3.5, 17])("keeps fault defaults independent of catalog backoff multiplier %s", multiplier => {
  const initialCatalog = structuredClone(serverCatalog) as Catalog;
  initialCatalog.types.find(type => type.id === "call")!.params.find(param => param.name === "backoff")!
    .fields.find(param => param.name === "multiplier")!.initial = multiplier;
  render(<Settings sourceCatalog={initialCatalog} source={{ ...experiment, faults: [
    { target: "gateway", kind: "errors", from: "20s", to: "30s", failureRate: "90%" },
  ] }} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Fault kind" }), { target: { value: "slowdown" } });
  expect(JSON.parse(screen.getByTestId("fault-document").textContent!)).toEqual([
    { target: "gateway", from: "20s", to: "30s", kind: "slowdown", multiplier: 2 },
  ]);
  fireEvent.change(screen.getByRole("combobox", { name: "Fault kind" }), { target: { value: "errors" } });
  expect(JSON.parse(screen.getByTestId("fault-document").textContent!)).toEqual([
    { target: "gateway", from: "20s", to: "30s", kind: "errors", failureRate: "50%" },
  ]);
});

const replicaModel: ModelFile = { ...model, blocks: {
  ...model.blocks,
  gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, replicas: 3 }, replicaOverrides: { "2": { handlers: 1 } } },
  router: { type: "router", params: {} },
  db: { type: "database", params: { maxConnections: 7 } },
  pooler: { type: "pooler", params: { poolSize: 5 } },
}, connections: [...model.connections,
  { id: "route", type: "route", from: "router", to: "gateway", params: {} },
  { id: "pooled-call", type: "call", from: "gateway", to: "db", params: { pool: { size: 3 } } },
] };

it("lists replica and outgoing-call copy targets while excluding client, router and request", () => {
  render(<Settings sourceModel={replicaModel} />);
  const target = screen.getByRole("combobox", { name: "Fault target" });
  const values = within(target).getAllByRole<HTMLOptionElement>("option").map(option => option.value);
  expect(values).toEqual(expect.arrayContaining(["gateway", "gateway#1", "gateway#2", "gateway#3", "gateway-to-middle#2", "pooled-call#3", "route", "db", "pooler"]));
  expect(values).not.toEqual(expect.arrayContaining(["client"]));
  expect(values).not.toContain("router");
  expect(values).not.toContain("client-to-gateway");
  expect(within(target).getByRole<HTMLOptionElement>("option", { name: "gateway#2 → middle (gateway-to-middle#2)" }).value).toBe("gateway-to-middle#2");
  expect(within(target).getByRole<HTMLOptionElement>("option", { name: "router → gateway (route)" }).value).toBe("route");
});

it.each([
  ["gateway-to-middle", true], ["route", true], ["pooled-call#2", false],
  ["gateway#2", false], ["db", false], ["pooler", false],
] as const)("limits capacity-loss availability for %s", (target, disabled) => {
  render(<Settings sourceModel={replicaModel} sourceCatalog={serverCatalog as Catalog} source={{ ...experiment, faults: [
    { target, kind: "blackhole", from: "20s", to: "30s" },
  ] }} />);
  expect(within(screen.getByRole("combobox", { name: "Fault kind" })).getByRole<HTMLOptionElement>("option", { name: "Capacity loss" }).disabled).toBe(disabled);
});

it("prevents moving capacity loss to a target without slots and bounds it by replica capacity", () => {
  render(<Settings sourceModel={replicaModel} sourceCatalog={serverCatalog as Catalog} source={{ ...experiment, faults: [
    { target: "gateway#2", kind: "capacityLoss", from: "20s", to: "30s", capacity: 1 },
  ] }} />);
  const target = screen.getByRole("combobox", { name: "Fault target" });
  expect(within(target).getByRole<HTMLOptionElement>("option", { name: "router → gateway (route)" }).disabled).toBe(true);
  const capacity = screen.getByRole("textbox", { name: "Available handlers" });
  fireEvent.change(capacity, { target: { value: "2" } });
  expect(capacity.getAttribute("aria-invalid")).toBe("true");
});

it("bounds group capacity only by effective replicas when all override the base upward", () => {
  const sourceModel: ModelFile = { ...model, blocks: { ...model.blocks,
    gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, replicas: 2 },
      replicaOverrides: { "1": { handlers: 8 }, "2": { handlers: 10 } } },
  } };
  render(<Settings sourceModel={sourceModel} source={{ ...experiment, faults: [
    { target: "gateway", kind: "capacityLoss", from: "200ms", to: "700ms", capacity: 8 },
  ] }} />);
  const capacity = screen.getByRole("textbox", { name: "Available handlers" });
  expect(capacity.getAttribute("aria-invalid")).toBeNull();
  fireEvent.change(capacity, { target: { value: "9" } });
  expect(capacity.getAttribute("aria-invalid")).toBe("true");
});

it("keeps very large replica groups bounded and selects an arbitrary copy by number with Undo", () => {
  const sourceModel: ModelFile = { ...model, blocks: { ...model.blocks,
    gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, replicas: 4294967296 } },
  } };
  render(<Settings sourceModel={sourceModel} source={{ ...experiment, faults: [
    { target: "gateway-to-middle", kind: "blackhole", from: "200ms", to: "700ms" },
  ] }} />);
  const target = screen.getByRole("combobox", { name: "Fault target" });
  expect(within(target).getAllByRole("option").length).toBeLessThan(250);
  const number = screen.getByRole("textbox", { name: "Replica number" });
  fireEvent.change(number, { target: { value: "4294967296" } });
  fireEvent.blur(number);
  expect(JSON.parse(screen.getByTestId("fault-document").textContent!)[0].target).toBe("gateway-to-middle#4294967296");
  expect(screen.getByTestId("history-size").textContent).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(JSON.parse(screen.getByTestId("fault-document").textContent!)[0].target).toBe("gateway-to-middle");
});

it.each([
  ["en", "Processing time multiplier", "Network delay multiplier", "More about: ", "sample × multiplier + delay"],
  ["ru", "Множитель времени обработки", "Множитель сетевой задержки", "Подробнее: ", "время × множитель + задержка"],
] as const)("labels slowdown by its target and explains the formula in %s", (language, blockLabel, callLabel, prefix, formula) => {
  setLanguage(language);
  render(<Settings />);
  const multiplier = screen.getByRole("textbox", { name: blockLabel });
  fireEvent.click(screen.getByRole("button", { name: prefix + blockLabel }));
  expect(screen.getByRole("tooltip").textContent).toContain(formula);
  expect(multiplier.getAttribute("aria-describedby")).toContain(screen.getByRole("tooltip").id);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.change(screen.getByRole("combobox", { name: language === "ru" ? "Цель отказа" : "Fault target" }), { target: { value: "gateway-to-middle" } });
  expect(screen.getByRole("textbox", { name: callLabel })).toBeTruthy();
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
