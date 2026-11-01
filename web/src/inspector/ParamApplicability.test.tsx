import { useReducer } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Catalog, ModelFile } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState, setModelParam } from "../workspace/editor";
import { applyOverrides, elementOf } from "../workspace/params";
import { setVariantParam } from "../workspace/experimentCommands";
import { ParamField } from "./ParamField";
import { InlineParamEditor } from "../canvas/InlineParamEditor";

const catalog = serverCatalog as Catalog;

function Fields({ initialModel = model, variant = false, inline = false }: { initialModel?: ModelFile; variant?: boolean; inline?: boolean }) {
  const documents = { model: initialModel, experiment, layout };
  const [state, dispatch] = useReducer(editorReducer, editorReducer(initialEditorState, { type: "open", loaded: {
    ...documents, saved: documents, experimentPath: "e.experiment.json", modelPath: "m.model.json", layoutPath: "l.layout.json",
    versions: { model: "m", experiment: "e", layout: "l" },
  } }));
  const loaded = state.loaded!;
  const effective = variant ? applyOverrides(loaded.model, loaded.experiment.variants[0].overrides, catalog) : loaded.model;
  const params = elementOf(effective, "gateway-to-middle")!.params;
  const commit = (path: string, value: unknown) => dispatch({ type: "command", command: variant
    ? setVariantParam("baseline", "gateway-to-middle", path, value, catalog)
    : setModelParam("gateway-to-middle", path, value, catalog) });
  return <>
    <button onClick={() => dispatch({ type: "undo" })}>Undo</button>
    <button onClick={() => dispatch({ type: "redo" })}>Redo</button>
    {catalog.types.find(type => type.id === "call")!.params.filter(param => ["network", "backoff"].includes(param.name)).map(descriptor =>
      <ParamField key={descriptor.name} descriptor={descriptor} value={params[descriptor.name]} path={descriptor.name} editable
        isOverridden={() => false} onCommit={value => commit(descriptor.name, value)}
        onFieldCommit={variant ? commit : undefined} onValidity={vi.fn()} />)}
    {inline ? <InlineParamEditor catalog={catalog} elementId="gateway-to-middle" elementType="call" params={params}
      path="network.kind" editable onCommit={value => commit("network.kind", value)} onValidity={vi.fn()} /> : null}
    <output data-testid="params">{JSON.stringify(params)}</output>
    <output data-testid="history">{state.past.length}</output>
    <output data-testid="experiment">{JSON.stringify(loaded.experiment)}</output>
  </>;
}

const params = () => JSON.parse(screen.getByTestId("params").textContent!);

it.each([false, true])("changes distribution atomically with Undo and Redo (variant=%s)", variant => {
  render(<Fields variant={variant} />);
  const network = within(screen.getByRole("group", { name: "Network delay" }));
  expect(network.queryByRole("textbox", { name: "Standard deviation" })).toBeNull();
  fireEvent.change(network.getByRole("combobox", { name: "Distribution" }), { target: { value: "lognormal" } });
  expect((network.getByRole("textbox", { name: "Standard deviation" }) as HTMLInputElement).value).toBe("0.5ms");
  expect(params().network).toEqual({ kind: "lognormal", mean: "0.5ms", stdDev: "0.5ms" });
  expect(screen.getByTestId("history").textContent).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(params().network).toEqual({ kind: "fixed", mean: "0.5ms" });
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(params().network.stdDev).toBe("0.5ms");
  fireEvent.change(network.getByRole("combobox", { name: "Distribution" }), { target: { value: "fixed" } });
  expect(params().network).toEqual({ kind: "fixed", mean: "0.5ms" });
  expect(network.queryByRole("textbox", { name: "Standard deviation" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(params().network).toEqual({ kind: "lognormal", mean: "0.5ms", stdDev: "0.5ms" });
});

it.each([false, true])("removes inactive backoff fields in one history entry (variant=%s)", variant => {
  render(<Fields variant={variant} />);
  const backoff = within(screen.getByRole("group", { name: "Backoff" }));
  fireEvent.change(backoff.getByRole("combobox", { name: "Kind" }), { target: { value: "fixed" } });
  expect(params().backoff).toEqual({ kind: "fixed", base: "2ms", max: "20ms" });
  expect(backoff.queryByRole("textbox", { name: "Multiplier" })).toBeNull();
  fireEvent.change(backoff.getByRole("combobox", { name: "Kind" }), { target: { value: "none" } });
  expect(params().backoff).toEqual({ kind: "none" });
  expect(backoff.queryByRole("textbox", { name: "Base delay" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(params().backoff).toEqual({ kind: "fixed", base: "2ms", max: "20ms" });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(params().backoff.multiplier).toBe(2);
});

it.each([false, true])("initializes an enabled exponential backoff with nonzero catalog delays (variant=%s)", variant => {
  const initialModel = { ...model, connections: model.connections.map(edge => edge.id === "gateway-to-middle"
    ? { ...edge, params: { ...edge.params, backoff: { kind: "none" } } } : edge) };
  render(<Fields initialModel={initialModel} variant={variant} />);
  const backoff = within(screen.getByRole("group", { name: "Backoff" }));
  fireEvent.change(backoff.getByRole("combobox", { name: "Kind" }), { target: { value: "exponential-full-jitter" } });
  expect(params().backoff).toEqual({ kind: "exponential-full-jitter", base: "10ms", max: "100ms", multiplier: 2 });
  expect(screen.getByTestId("history").textContent).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(params().backoff).toEqual({ kind: "none" });
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(params().backoff).toEqual({ kind: "exponential-full-jitter", base: "10ms", max: "100ms", multiplier: 2 });
});

it.each(["lognormal", "exponential"])("initializes a zero mean before switching to %s through inline editing", kind => {
  const initialModel = { ...model, connections: model.connections.map(edge => edge.id === "gateway-to-middle"
    ? { ...edge, params: { ...edge.params, network: { kind: "fixed", mean: "0ms" } } } : edge) };
  render(<Fields initialModel={initialModel} inline />);
  fireEvent.doubleClick(screen.getByTestId("canvas-param-gateway-to-middle-network.kind"));
  fireEvent.change(within(screen.getByTestId("canvas-param-gateway-to-middle-network.kind")).getByRole("combobox"), { target: { value: kind } });
  expect(params().network).toEqual({ kind, mean: "1ms", ...(kind === "lognormal" ? { stdDev: "1ms" } : {}) });
  expect(screen.getByTestId("history").textContent).toBe("1");
});

it("replaces a model's lognormal object in the variant without leaving inherited stdDev", () => {
  const initialModel = { ...model, connections: model.connections.map(edge => edge.id === "gateway-to-middle"
    ? { ...edge, params: { ...edge.params, network: { kind: "lognormal", mean: "2ms", stdDev: "1ms" } } } : edge) };
  render(<Fields initialModel={initialModel} variant />);
  const network = within(screen.getByRole("group", { name: "Network delay" }));
  fireEvent.change(network.getByRole("combobox", { name: "Distribution" }), { target: { value: "fixed" } });
  expect(params().network).toEqual({ kind: "fixed", mean: "2ms" });
  expect(JSON.parse(screen.getByTestId("experiment").textContent!).variants[0].overrides)
    .toEqual({ "gateway-to-middle.network": { kind: "fixed", mean: "2ms" } });
  expect(elementOf(initialModel, "gateway-to-middle")!.params.network).toEqual({ kind: "lognormal", mean: "2ms", stdDev: "1ms" });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(params().network).toEqual({ kind: "lognormal", mean: "2ms", stdDev: "1ms" });
});

it("hides an inapplicable inline field even when an imported document contains it", () => {
  render(<InlineParamEditor catalog={catalog} elementId="call" elementType="call" params={{ network: { kind: "fixed", mean: "1ms", stdDev: "2ms" } }}
    path="network.stdDev" editable onCommit={vi.fn()} onValidity={vi.fn()} />);
  expect(screen.queryByTestId("canvas-param-call-network.stdDev")).toBeNull();
});
