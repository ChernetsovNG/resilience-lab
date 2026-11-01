import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useLayoutEffect, useRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { mockReactFlowDom } from "../test/reactFlow";
import { Canvas, type CanvasHandle } from "./Canvas";
import { VariantTabs } from "./VariantTabs";
import { canvasResults, type CanvasResults } from "../results/canvasResults";
import { summary } from "../test/fixtures";
import { setLanguage } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import { overlayOutputs } from "../results/outputs";
import type { Catalog, TypeDescriptor } from "../api/apiTypes";
import fullCatalog from "../test/catalog.json";
import { setViewSettings } from "../layout/viewSettings";
import type { EditorCommand } from "../workspace/editor";
import { applyOverrides } from "../workspace/params";
import * as edgeGeometry from "./edgeGeometry";
import * as blockGeometry from "./blockGeometry";

beforeAll(mockReactFlowDom);

it("keeps a result centered through late measurements and releases it on a canvas gesture", async () => {
  const observer = globalThis.ResizeObserver;
  const heightProperty = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  const measurements: (() => void)[] = [];
  let targetHeight = 80;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() {
    return (this as HTMLElement).dataset.id === "dependency" ? targetHeight : 80;
  } });
  globalThis.ResizeObserver = class extends observer {
    observe(target: Element) { measurements.push(() => super.observe(target)); super.observe(target); }
  };
  try {
    const ref = createRef<CanvasHandle>();
    const { container } = render(<Canvas ref={ref} catalog={catalog} model={model} layout={layout} selected={[]}
      onSelect={vi.fn()} onCommand={vi.fn()} />);
    const viewport = () => {
      const [, x, y, zoom] = container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform
        .match(/translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.]+)\)/)!;
      return { x: Number(x), y: Number(y), zoom: Number(zoom) };
    };
    await waitFor(() => expect(viewport().zoom).toBeLessThan(0.7));
    act(() => ref.current!.focusElement("dependency"));
    await waitFor(() => expect(viewport().zoom).toBeGreaterThanOrEqual(0.7));
    targetHeight = 160;
    await act(async () => { measurements.forEach(measure => measure()); });
    await waitFor(() => expect(viewport().y + (layout.positions.dependency.y + 80) * viewport().zoom).toBeCloseTo(48));
    const zoomIn = screen.getByRole("button", { name: "Zoom In" });
    fireEvent.mouseDown(zoomIn); fireEvent.click(zoomIn);
    await waitFor(() => expect(viewport().zoom).toBeGreaterThan(0.7));
    const manual = viewport();
    targetHeight = 240;
    await act(async () => { measurements.forEach(measure => measure()); await new Promise(requestAnimationFrame); });
    expect(viewport()).toEqual(manual);
  } finally {
    globalThis.ResizeObserver = observer;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightProperty);
  }
});

it("centers a result node at readable zoom and preserves a larger zoom on repeated navigation", async () => {
  const ref = createRef<CanvasHandle>();
  const props = { catalog, model, layout, selected: [], onSelect: vi.fn(), onCommand: vi.fn(), bottomInset: 20 };
  const { container, rerender } = render(<Canvas ref={ref} {...props} />);
  const viewport = () => {
    const transform = container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    const [, x, y, zoom] = transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.]+)\)/)!;
    return { x: Number(x), y: Number(y), zoom: Number(zoom) };
  };
  await waitFor(() => expect(viewport().zoom).toBeLessThan(0.7));
  act(() => ref.current!.focusElement("dependency"));
  await waitFor(() => expect(viewport().zoom).toBeGreaterThanOrEqual(0.7));
  expect(viewport().x + (layout.positions.dependency.x + 90) * viewport().zoom).toBeCloseTo(90);
  expect(viewport().y + (layout.positions.dependency.y + 40) * viewport().zoom).toBeCloseTo(38);
  fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
  await waitFor(() => expect(viewport().zoom).toBeGreaterThan(0.7));
  const larger = viewport().zoom;
  act(() => ref.current!.focusElement("middle"));
  await waitFor(() => expect(viewport().x + (layout.positions.middle.x + 90) * viewport().zoom).toBeCloseTo(90));
  expect(viewport().zoom).toBe(larger);
  const focused = viewport();
  rerender(<Canvas ref={ref} {...props} results={canvasResults(summary, model, "baseline", "p0", catalog)} />);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(viewport()).toEqual(focused);
});

it("centers a connection result on its measured label", async () => {
  const ref = createRef<CanvasHandle>();
  const { container } = render(<Canvas ref={ref} catalog={catalog} model={model} layout={layout} selected={[]}
    onSelect={vi.fn()} onCommand={vi.fn()} />);
  const label = await screen.findByTestId("canvas-edge-label-middle-to-dependency");
  await act(async () => { await new Promise(requestAnimationFrame); });
  act(() => ref.current!.focusElement("middle-to-dependency"));
  await waitFor(() => {
    const [, x, y, zoom] = container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform
      .match(/translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.]+)\)/)!;
    const [, labelX, labelY] = label.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!;
    expect(Number(zoom)).toBeGreaterThanOrEqual(0.7);
    expect(Number(x) + Number(labelX) * Number(zoom)).toBeCloseTo(90);
    expect(Number(y) + Number(labelY) * Number(zoom)).toBeCloseTo(48);
  });
});

it("updates zoom without rendering block shapes again", async () => {
  const renders = vi.spyOn(blockGeometry, "blockGeometry");
  const onZoomChange = vi.fn();
  try {
    const { container } = render(<Canvas catalog={catalog} model={model} layout={layout} selected={[]}
      onSelect={vi.fn()} onCommand={vi.fn()} onZoomChange={onZoomChange} />);
    await waitFor(() => expect(onZoomChange).toHaveBeenCalled());
    await act(async () => { await new Promise(requestAnimationFrame); });
    const before = renders.mock.calls.length;
    const initial = onZoomChange.mock.lastCall![0] as number;
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    await waitFor(() => expect(onZoomChange.mock.lastCall![0]).toBeCloseTo(initial * 1.2, 6));
    expect(renders).toHaveBeenCalledTimes(before);
    expect(container.querySelector<HTMLElement>(".react-flow")!.style.getPropertyValue("--port-hit-size"))
      .toBe(`${12 / (initial * 1.2)}px`);
  } finally { renders.mockRestore(); }
});

it.each([
  { classes: ["status"], label: "status" },
  { classes: ["status", "read"], label: "status, read" },
  { classes: ["status", "read", "checkout", "write"], label: "status +3" },
])("shows route request types as $label with a full tooltip", async ({ classes, label }) => {
  const initial = structuredClone(model);
  initial.blocks.middle = { type: "router", params: { policy: "roundRobin" } };
  Object.assign(initial.connections.find(edge => edge.id === "middle-to-dependency")!, { type: "route", classes, params: {} });
  render(<Canvas catalog={fullCatalog as Catalog} model={initial} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  const badge = await screen.findByTestId("canvas-edge-label-middle-to-dependency");
  expect(within(badge).getByText(label, { exact: true })).toBeTruthy();
  fireEvent.click(within(badge).getByRole("button", { name: "More about: Routed request types" }));
  expect(within(badge).getByRole("tooltip").textContent).toBe(`Routed here: ${classes.join(", ")}`);
});

it("selects a connection from its endpoint label while retaining its document id", async () => {
  const onSelect = vi.fn();
  render(<Canvas catalog={catalog} model={model} layout={layout} selected={[]} onSelect={onSelect} onCommand={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "gateway → middle (gateway-to-middle)" }));
  expect(onSelect).toHaveBeenCalledWith(["gateway-to-middle"]);
});

it("reuses edge geometry when node bounds and label sizes have not changed", async () => {
  const calculate = vi.spyOn(edgeGeometry, "layoutEdges");
  try {
    const props = { catalog, model, layout, selected: [], onSelect: vi.fn(), onCommand: vi.fn() };
    const { container, rerender } = render(<Canvas {...props} />);
    await waitFor(() => {
      const paths = [...container.querySelectorAll(".react-flow__edge-path")];
      expect(paths).toHaveLength(model.connections.length);
      expect(paths.every(path => !path.getAttribute("d")!.includes("C"))).toBe(true);
    });
    const count = calculate.mock.calls.length;
    rerender(<Canvas {...props} layout={structuredClone(layout)} selected={["gateway-to-middle"]} />);
    expect(calculate).toHaveBeenCalledTimes(count);
    const paths = [...container.querySelectorAll(".react-flow__edge-path")].map(path => path.getAttribute("d"));
    const changed = structuredClone(model);
    changed.connections[1].params.timeout = "90ms";
    rerender(<Canvas {...props} model={changed} />);
    expect([...container.querySelectorAll(".react-flow__edge-path")].map(path => path.getAttribute("d"))).toEqual(paths);
    expect(calculate).toHaveBeenCalledTimes(count);
    const moved = structuredClone(layout);
    moved.positions.middle.x += 40;
    rerender(<Canvas {...props} layout={moved} />);
    expect(calculate.mock.calls.length).toBeGreaterThan(count);
  } finally { calculate.mockRestore(); }
});

it("shows database connections on its node without an internal type name", async () => {
  const snapshot = structuredClone(model);
  snapshot.blocks.middle = { type: "database", params: { maxConnections: 3, queue: 4, processing: { kind: "fixed", mean: "5ms" } } };
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={snapshot} layout={layout} selected={[]}
    onSelect={vi.fn()} onCommand={vi.fn()} />);
  const node = await screen.findByTestId("rf__node-middle");
  expect(node.textContent).toContain("connections:");
  expect(node.querySelector(".block-type-icon")?.getAttribute("title")).toBe("Database");
  expect(screen.getByTestId("canvas-param-middle-maxConnections").textContent).toBe("3");
  expect(node.textContent).not.toContain("handlers");
  expect(node.querySelector(".block-summary")?.childElementCount).toBe(3);
});

it("retains an insertion activated before the viewport has its initial dimensions", async () => {
  const onCommand = vi.fn();
  function EarlyActivation() {
    const ref = useRef<CanvasHandle>(null);
    useLayoutEffect(() => { ref.current!.addBlock("service"); }, []);
    return <Canvas ref={ref} catalog={catalog} model={model} layout={layout} selected={[]} onSelect={vi.fn()}
      onCommand={onCommand} editable />;
  }
  render(<EarlyActivation />);
  await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
  const command = onCommand.mock.lastCall![0] as EditorCommand;
  expect(command({ model, layout, experiment }).model.blocks["service-1"].type).toBe("service");
});

it("marks overridden route weights before any results exist", async () => {
  const base = structuredClone(model);
  base.blocks.middle = { type: "router", params: { policy: "weighted" } };
  const route = base.connections.find(connection => connection.id === "middle-to-dependency")!;
  route.type = "route";
  route.params = { weight: 1 };
  const variant = { id: "route-change", overrides: { "middle-to-dependency.weight": 2 } };
  const extended = fullCatalog as Catalog;
  render(<Canvas model={applyOverrides(base, variant.overrides, extended)} baseModel={base} catalog={extended}
    variant={variant} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  const label = await screen.findByTestId("canvas-edge-label-middle-to-dependency");
  expect(label.classList.contains("canvas-edge-label--overridden")).toBe(true);
  expect(label.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Overridden parameters");
  expect(screen.getByTestId("canvas-param-middle-to-dependency-weight").querySelector("del")?.textContent).toBe("1");
});

it("marks only overridden elements and shows their model values while preserving metric backgrounds", async () => {
  const variant = { id: "changed", overrides: { "gateway.handlers": 6, "gateway.processing.mean": "8ms", "gateway-to-middle.attempts": 1 } };
  const snapshot = applyOverrides(model, variant.overrides, catalog);
  const props = { catalog, model: snapshot, baseModel: model, variant, layout, selected: [],
    onSelect: vi.fn(), onCommand: vi.fn(), parametersEditable: true };
  const { rerender } = render(<Canvas {...props} />);
  const gateway = await screen.findByTestId("rf__node-gateway");
  expect(gateway.querySelector(".block-node--overridden")).not.toBeNull();
  expect(screen.getByTestId("rf__node-middle").querySelector(".block-node--overridden")).toBeNull();
  expect(screen.getByTestId("canvas-param-gateway-handlers").querySelector("del")?.textContent).toBe("4");
  expect(screen.getByTestId("canvas-param-gateway-processing.mean").querySelector("del")?.textContent).toBe("1 ms");
  expect(screen.getByTestId("canvas-param-gateway-queue").querySelector("del")).toBeNull();
  expect(screen.getByTestId("canvas-edge-label-gateway-to-middle").classList.contains("canvas-edge-label--overridden")).toBe(true);
  expect(screen.getByTestId("canvas-param-gateway-to-middle-attempts").querySelector("del")?.textContent).toBe("3");
  const results = canvasResults(summary, model, "baseline", "p0", catalog)!;
  rerender(<Canvas {...props} results={results} />);
  expect((gateway.querySelector(".block-node") as HTMLElement).style.getPropertyValue("--node-fill")).not.toBe("");
  expect(gateway.querySelector(".block-node--overridden")).not.toBeNull();
});

it.each([true, false])("uses the live grid for the background and drops with snapping %s", async snapToGrid => {
  const onCommand = vi.fn();
  const { container } = render(<Canvas catalog={catalog} model={model} layout={layout} selected={[]} onSelect={vi.fn()}
    onCommand={onCommand} editable />);
  const node = await screen.findByTestId("rf__node-gateway");
  const original = node.style.transform;
  try {
    act(() => { setViewSettings({ gridStep: 40, snapToGrid }); });
    expect(node.style.transform).toBe(original);
    const transform = container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    const [, x, y, zoom] = transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.]+)\)/)!;
    expect(Number(container.querySelector(".react-flow__background pattern")!.getAttribute("width")) / Number(zoom)).toBeCloseTo(40);
    act(() => { setViewSettings({ showGrid: false }); });
    expect(container.querySelector(".react-flow__background")).toBeNull();
    const drop = new MouseEvent("drop", { bubbles: true, clientX: 91.5, clientY: 49.25 });
    Object.defineProperty(drop, "dataTransfer", { value: { getData: () => "service" } });
    fireEvent(container.querySelector(".react-flow")!, drop);
    const command = onCommand.mock.lastCall![0] as EditorCommand;
    const position = command({ model, layout, experiment }).layout.positions["service-1"];
    if (snapToGrid) {
      expect(position.x % 40).toBe(0);
      expect(position.y % 40).toBe(0);
    } else {
      expect(position.x).toBeCloseTo((91.5 - Number(x)) / Number(zoom));
      expect(position.y).toBeCloseTo((49.25 - Number(y)) / Number(zoom));
    }
  } finally { act(() => { setViewSettings({ gridStep: 20, snapToGrid: true, showGrid: true }); }); }
});

it("includes the full metric label and a large queue value in its tooltip", async () => {
  const results = canvasResults(summary, model, "baseline", "p0", catalog)!;
  results.services.get("gateway")!.values.meanQueue = 9_999_999.99;
  render(<Canvas catalog={catalog} model={model} layout={layout} selected={[]} onSelect={vi.fn()}
    onCommand={vi.fn()} results={results} />);
  const metrics = await screen.findByTestId("canvas-results-gateway");
  const hint = within(metrics).getByRole("button", { name: "More about: Mean queue" });
  fireEvent.click(hint);
  const tooltip = within(metrics).getByRole("tooltip");
  expect(tooltip.textContent).toContain("Mean queue");
  expect(tooltip.textContent).toContain("9,999,999.99");
  expect(tooltip.textContent).toContain("Average number of attempts waiting for a handler");
});

it("explains attempts below one beside the connection value", async () => {
  const run = structuredClone(summary);
  run.variants[0].points[0].aggregate.services.gateway.admittedAmplification!.mean = 0.8;
  render(<Canvas catalog={catalog} model={model} layout={layout} selected={[]} onSelect={vi.fn()}
    onCommand={vi.fn()} results={canvasResults(run, model, "baseline", "p0", catalog)} />);
  const badge = await screen.findByTestId("canvas-edge-label-client-to-gateway");
  expect(badge.textContent).toContain("0.8×");
  expect(badge.textContent).toContain("Not every request reached it");
});

it("one shared utilization choice colors both services and databases", async () => {
  const extended = fullCatalog as Catalog;
  const snapshot = { ...model, blocks: { ...model.blocks, middle: { ...model.blocks.middle, type: "database",
    params: { maxConnections: 4, queue: 16, processing: { kind: "fixed", mean: "1ms" } } } } };
  const run = structuredClone(summary);
  run.variants[0].points[0].aggregate.services.middle = structuredClone(run.variants[0].points[0].aggregate.services.gateway);
  const choices = overlayOutputs(extended, "BLOCK", snapshot).filter(output => output.overlay!.title === "Utilization");
  expect(choices).toHaveLength(1);
  expect(choices[0].key).toBe("utilization");
  expect(choices[0].types).toEqual(["service", "database"]);
  render(<Canvas catalog={extended} model={snapshot} layout={layout} onCommand={vi.fn()} onSelect={vi.fn()} selected={[]}
    results={canvasResults(run, snapshot, "baseline", "p0", extended)} nodeMetric={choices[0].key} />);
  await screen.findByTestId("canvas-results-middle");
  const color = (id: string) => screen.getByTestId(`rf__node-${id}`).querySelector<HTMLElement>(".block-node")!.style.getPropertyValue("--node-fill");
  expect(color("gateway")).not.toBe("");
  expect(color("middle")).toBe(color("gateway"));
});

it("applies colliding output ids only to the type selected in the overlay", async () => {
  const service = catalog.types.find(type => type.id === "service")!;
  const pool: TypeDescriptor = { ...service, id: "pool", title: "Pool", outputs: [{
    ...service.outputs.find(output => output.id === "admittedAttemptsPerSecond")!, id: "meanQueue",
    overlay: { title: "Pool throughput", label: "Pool throughput {value}", description: "Pool throughput", order: 1 },
  }] };
  const extended = { ...catalog, types: [...catalog.types, pool] };
  const snapshot = { ...model, blocks: { ...model.blocks, middle: { ...model.blocks.middle, type: pool.id } } };
  const run = structuredClone(summary);
  run.variants[0].points[0].aggregate.services.middle = structuredClone(run.variants[0].points[0].aggregate.services.gateway);
  const choices = overlayOutputs(extended, "BLOCK").filter(output => output.id === "meanQueue");
  const props = { catalog: extended, model: snapshot, layout, onCommand: vi.fn(), onSelect: vi.fn(), selected: [],
    results: canvasResults(run, snapshot, "baseline", "p0", extended) };
  const view = render(<Canvas {...props} nodeMetric={choices[0].key} />);
  await screen.findByTestId("canvas-results-middle");
  const color = (id: string) => screen.getByTestId(`rf__node-${id}`).querySelector<HTMLElement>(".block-node")!.style.getPropertyValue("--node-fill");
  expect(color("gateway")).not.toBe("");
  expect(color("middle")).toBe("");
  expect(screen.getByTestId("canvas-results-middle").textContent).toContain("Pool throughput 120 RPS");
  view.rerender(<Canvas {...props} nodeMetric={choices[1].key} />);
  expect(color("gateway")).toBe("");
  expect(color("middle")).not.toBe("");
});

describe("Canvas", () => {
  it.each([1, 4, 10])("keeps service parameter labels and values together with %s handlers", async handlers => {
    setLanguage("ru");
    try {
      const configured = { ...model, blocks: { ...model.blocks,
        gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers } },
      } };
      render(<Canvas catalog={localizeCatalog(catalog)} onCommand={vi.fn()} model={configured} layout={layout}
        selected={[]} onSelect={vi.fn()} />);
      const node = await screen.findByTestId("rf__node-gateway");
      const pairs = node.querySelectorAll(".block-summary > span");
      expect([...pairs].map(pair => pair.textContent?.trim()))
        .toEqual([`обработчики: ${handlers}`, "очередь: 16", "среднее: 1 мс"]);
      for (const pair of pairs) expect(pair.querySelector(".inline-param")).not.toBeNull();
    } finally { setLanguage("en"); localStorage.removeItem("resilience-lab.language"); }
  });

  it("publishes zoom after connected nodes have been measured", async () => {
    const observer = globalThis.ResizeObserver;
    const measurements: (() => void)[] = [];
    globalThis.ResizeObserver = class extends observer {
      observe(target: Element) {
        if (target.classList.contains("react-flow__node")) measurements.push(() => super.observe(target));
        else super.observe(target);
      }
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const onZoomChange = vi.fn();
      render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={vi.fn()}
        onZoomChange={onZoomChange} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(measurements.length).toBeGreaterThan(0);
      expect(onZoomChange).not.toHaveBeenCalled();
      await act(async () => {
        measurements.forEach(measure => measure());
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(onZoomChange).toHaveBeenCalled();
      expect(screen.getByTestId("rf__edge-gateway-to-middle")).toBeTruthy();
    } finally {
      globalThis.ResizeObserver = observer;
      vi.useRealTimers();
    }
  });

  function renderEditable(onParam = vi.fn(), onValidity = vi.fn()) {
    render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={vi.fn()}
      parametersEditable onParam={onParam} onValidity={onValidity} />);
    return { onParam, onValidity };
  }

  function openParam(id: string): HTMLInputElement {
    const parameter = screen.getByTestId(`canvas-param-${id}`);
    fireEvent.doubleClick(parameter);
    return parameter.querySelector("input")!;
  }

  function submit(input: HTMLInputElement) {
    fireEvent.submit(input.closest("form")!);
  }

  it("shows finding counts and the greatest severity on blocks and connections", async () => {
    const warning = { code: "LINT_TIMEOUT_BUDGET", severity: "WARNING" as const, message: "Check timeout" };
    render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={vi.fn()} elementDiagnostics={new Map([
      ["gateway", [warning, { ...warning, severity: "ERROR" }]],
      ["gateway-to-middle", [warning]],
    ])} />);
    expect(await screen.findByRole("img", { name: "2 problems: error" })).toBeTruthy();
    expect((await screen.findByTestId("canvas-edge-label-gateway-to-middle")).textContent).toContain("⚠ 1");
  });
  it("draws blocks with key parameters and reports the selection", async () => {
    const onSelect = vi.fn();
    render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={onSelect} />);
    expect(await screen.findAllByTestId("block-node")).toHaveLength(4);
    expect(screen.getByTestId("canvas-param-gateway-handlers").textContent).toBe("4");
    expect(screen.getByTestId("canvas-param-gateway-queue").textContent).toBe("16");
    expect(screen.getByTestId("canvas-param-gateway-processing.mean").textContent).toBe("1 ms");
    expect(screen.getByTestId("canvas-param-client-load.points.0.rate").textContent).toBe("120/s");
    expect(screen.getByTestId("canvas-param-client-deadline").textContent).toBe("250 ms");
    fireEvent.click(screen.getByTestId("rf__node-gateway"));
    expect(onSelect).toHaveBeenCalledWith(["gateway"]);
  });

  it("labels call connections, selects an edge and clears selection on the pane", async () => {
    const onSelect = vi.fn();
    const { container } = render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={onSelect} />);
    const edge = await screen.findByTestId("rf__edge-gateway-to-middle");
    expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("80 ms");
    expect(screen.getByTestId("canvas-param-gateway-to-middle-attempts").textContent).toBe("3");
    expect(screen.getByTestId("canvas-param-middle-to-dependency-timeout").textContent).toBe("60 ms");
    expect(screen.getByTestId("rf__edge-client-to-gateway").textContent).toBe("");
    fireEvent.click(edge);
    expect(onSelect).toHaveBeenLastCalledWith(["gateway-to-middle"]);
    onSelect.mockClear();
    fireEvent.click(screen.getByTestId("canvas-edge-label-gateway-to-middle"));
    expect(onSelect).toHaveBeenLastCalledWith(["gateway-to-middle"]);
    fireEvent.click(container.querySelector(".react-flow__pane")!);
    expect(onSelect).toHaveBeenCalledWith([]);
  });

  it("reflects controlled selection and keeps block positions and ports read-only", async () => {
    const props = { model, layout, onSelect: vi.fn() };
    const { container, rerender } = render(<Canvas catalog={catalog} onCommand={vi.fn()} {...props} selected={["gateway"]} />);
    const node = await screen.findByTestId("rf__node-gateway");
    expect(node.classList.contains("selected")).toBe(true);
    expect(node.style.transform).toBe("translate(260px,100px)");
    expect(node.classList.contains("draggable")).toBe(false);
    expect(container.querySelector(".react-flow__handle.connectable")).toBeNull();
    expect(screen.getByTestId("rf__node-client").querySelector(".react-flow__handle.target")).toBeNull();
    expect(node.querySelector(".react-flow__handle.target")).toBeTruthy();
    rerender(<Canvas catalog={catalog} onCommand={vi.fn()} {...props} selected={["gateway-to-middle"]} />);
    expect(node.classList.contains("selected")).toBe(false);
    expect((await screen.findByTestId("rf__edge-gateway-to-middle")).classList.contains("selected")).toBe(true);
  });

  it("uses deterministic fallback positions with no layout and missing or inherited entries", async () => {
    const fallbackModel = {
      ...model,
      blocks: { client: model.blocks.client, ["constructor"]: model.blocks.gateway },
      connections: [],
    };
    const props = { model: fallbackModel, selected: [], onSelect: vi.fn() };
    const { rerender } = render(<Canvas catalog={catalog} onCommand={vi.fn()} {...props} layout={null} />);
    expect((await screen.findByTestId("rf__node-client")).style.transform).toBe("translate(0px,100px)");
    expect(screen.getByTestId("rf__node-constructor").style.transform).toBe("translate(260px,100px)");
    rerender(<Canvas catalog={catalog} onCommand={vi.fn()} {...props} layout={{ schemaVersion: 2, sizes: {}, edges: {}, positions: { client: { x: 40, y: 60 } } }} />);
    expect(screen.getByTestId("rf__node-client").style.transform).toBe("translate(40px,60px)");
    expect(screen.getByTestId("rf__node-constructor").style.transform).toBe("translate(260px,100px)");
  });

  it("shows omitted queue and attempt defaults", async () => {
    const defaultsModel = {
      ...model,
      blocks: { ...model.blocks, gateway: { type: "service", params: { handlers: 4 } } },
      connections: model.connections.map((connection) =>
        connection.id === "gateway-to-middle" ? { ...connection, params: { timeout: "80ms" } } : connection,
      ),
    };
    render(<Canvas catalog={catalog} onCommand={vi.fn()} model={defaultsModel} layout={layout} selected={[]} onSelect={vi.fn()} />);
    expect((await screen.findByTestId("canvas-param-gateway-queue")).textContent).toBe("0");
    expect((await screen.findByTestId("canvas-param-gateway-to-middle-attempts")).textContent).toBe("1");
  });

  it("formats numeric values on the canvas while keeping their editable document text", async () => {
    const onParam = vi.fn();
    const formattedModel = { ...model, blocks: {
      ...model.blocks, gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers: 1234 } },
    } };
    render(<Canvas catalog={catalog} onCommand={vi.fn()} model={formattedModel} layout={layout} selected={[]} onSelect={vi.fn()}
      parametersEditable onParam={onParam} />);
    const parameter = await screen.findByTestId("canvas-param-gateway-handlers");
    expect(parameter.textContent).toBe("1,234");
    expect(screen.getByRole("button", { name: "Handlers: 1,234" })).toBeTruthy();
    const input = openParam("gateway-handlers");
    expect(input.value).toBe("1234");
    submit(input);
    expect(onParam).not.toHaveBeenCalled();
  });

  it("edits service handlers, queue and processing mean from the node", async () => {
    const { onParam } = renderEditable();
    await screen.findAllByTestId("block-node");

    const handlers = openParam("gateway-handlers");
    fireEvent.change(handlers, { target: { value: "6" } });
    submit(handlers);
    const queue = openParam("gateway-queue");
    fireEvent.change(queue, { target: { value: "20" } });
    submit(queue);
    const mean = openParam("gateway-processing.mean");
    fireEvent.change(mean, { target: { value: "3ms" } });
    submit(mean);

    expect(onParam).toHaveBeenNthCalledWith(1, "gateway", "handlers", 6);
    expect(onParam).toHaveBeenNthCalledWith(2, "gateway", "queue", 20);
    expect(onParam).toHaveBeenNthCalledWith(3, "gateway", "processing.mean", "3ms");
  });

  it("edits timeout and attempts from the call label", async () => {
    const { onParam } = renderEditable();
    await screen.findByTestId("canvas-edge-label-gateway-to-middle");

    const timeout = openParam("gateway-to-middle-timeout");
    fireEvent.change(timeout, { target: { value: "90ms" } });
    submit(timeout);
    const attempts = openParam("gateway-to-middle-attempts");
    fireEvent.change(attempts, { target: { value: "2" } });
    submit(attempts);

    expect(onParam).toHaveBeenNthCalledWith(1, "gateway-to-middle", "timeout", "90ms");
    expect(onParam).toHaveBeenNthCalledWith(2, "gateway-to-middle", "attempts", 2);
  });

  it("does not reset an active draft on another double click", async () => {
    renderEditable();
    await screen.findAllByTestId("block-node");
    const input = openParam("gateway-handlers");
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.doubleClick(screen.getByTestId("canvas-param-gateway-handlers"));

    expect(input.value).toBe("6");
  });

  it("keeps a malformed draft with an error and reports invalid state", async () => {
    const { onParam, onValidity } = renderEditable();
    await screen.findAllByTestId("block-node");
    const input = openParam("gateway-handlers");
    fireEvent.change(input, { target: { value: "4.5" } });
    submit(input);

    expect(input.value).toBe("4.5");
    expect(screen.getByRole("alert").textContent).toContain("Enter a whole number");
    expect(onParam).not.toHaveBeenCalled();
    expect(onValidity).toHaveBeenLastCalledWith("gateway.handlers", false);
  });

  it("cancels an inline draft with Escape without committing it", async () => {
    const { onParam, onValidity } = renderEditable();
    await screen.findByTestId("canvas-edge-label-gateway-to-middle");
    const input = openParam("gateway-to-middle-timeout");
    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("80 ms");
    expect(screen.queryByRole("textbox", { name: "Timeout" })).toBeNull();
    expect(onParam).not.toHaveBeenCalled();
    expect(onValidity).toHaveBeenLastCalledWith("gateway-to-middle.timeout", true);
  });

  it("commits parseable range errors for core draft validation", async () => {
    const { onParam } = renderEditable();
    await screen.findAllByTestId("block-node");
    const input = openParam("gateway-handlers");
    fireEvent.change(input, { target: { value: "0" } });
    submit(input);

    expect(onParam).toHaveBeenCalledWith("gateway", "handlers", 0);
  });
});

describe("VariantTabs", () => {
  it("puts Model first and switches to every variant, including empty overrides", () => {
    const onSelect = vi.fn();
    render(<VariantTabs variants={experiment.variants} active={null} onSelect={onSelect} onInspect={vi.fn()} onCommand={vi.fn()} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Model", "Baseline", "No retries"]);
    expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect(onSelect).toHaveBeenLastCalledWith("baseline");
    fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
    expect(onSelect).toHaveBeenLastCalledWith("no-retries");
    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("marks the controlled active variant and names an unlabeled page", () => {
    render(<VariantTabs variants={[{ id: "plain", overrides: {} }]} active="plain" onSelect={vi.fn()} onInspect={vi.fn()} onCommand={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "Variant 1" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps page navigation disabled while an editable draft is invalid", () => {
    const onSelect = vi.fn();
    render(<VariantTabs variants={experiment.variants} active={null} disabled onSelect={onSelect} onInspect={vi.fn()} onCommand={vi.fn()} />);
    for (const tab of screen.getAllByRole("tab")) {
      expect((tab as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(tab);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
});

it("does not give old results to new nodes, new edges or retargeted edges", async () => {
  const current = {
    ...model,
    blocks: { ...model.blocks, added: model.blocks.gateway },
    connections: [
      ...model.connections.map((edge) => edge.id === "gateway-to-middle" ? { ...edge, to: "gateway" } : edge),
      { id: "new-call", from: "added", to: "gateway", type: "call", params: { timeout: "50ms" } },
    ],
  };
  render(<Canvas catalog={catalog} onCommand={vi.fn()} model={current} layout={layout} selected={[]} onSelect={vi.fn()}
    results={canvasResults(summary, model, "baseline", "p0", catalog)} />);
  expect(await screen.findByTestId("canvas-results-gateway")).toBeTruthy();
  expect(screen.queryByTestId("canvas-results-added")).toBeNull();
  expect(screen.getByTestId("canvas-edge-label-new-call").textContent).not.toContain("Amplification");
  expect(screen.getByTestId("canvas-edge-label-gateway-to-middle").textContent).not.toContain("Amplification");
  expect(screen.getByTestId("canvas-edge-label-client-to-gateway").textContent).toContain("Attempts per request 1.2×");
});


it("highlights a selected connection's endpoints and provides a wide line hit target", async () => {
  const onSelect = vi.fn();
  render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout}
    selected={["gateway-to-middle"]} onSelect={onSelect} />);
  const edge = await screen.findByTestId("rf__edge-gateway-to-middle");
  expect(edge.querySelector(".react-flow__edge-interaction")?.getAttribute("stroke-width")).toBe("28");
  expect(screen.getByTestId("rf__node-gateway").classList.contains("canvas-node--connected")).toBe(true);
  expect(screen.getByTestId("rf__node-middle").classList.contains("canvas-node--connected")).toBe(true);
  expect(screen.getByTestId("rf__node-dependency").classList.contains("canvas-node--connected")).toBe(false);
  const badge = screen.getByTestId("canvas-edge-label-gateway-to-middle");
  fireEvent.keyDown(badge, { key: "Enter" });
  expect(onSelect).toHaveBeenLastCalledWith(["gateway-to-middle"]);
});


it("changes connection overlay labels without borrowing target node values", async () => {
  const props = { catalog, model, layout, onCommand: vi.fn(), onSelect: vi.fn(), selected: [], results: {
    services: new Map(), connections: new Map([["gateway-to-middle", {
      from: "gateway", to: "middle", type: "call", hasOwnSeries: true, params: {},
      outputs: catalog.types.find(type => type.id === "call")!.outputs.filter(output => output.overlay != null),
      values: { amplification: 2.5, sentAttemptsPerSecond: 40, timeoutRate: 0.25, meanOrphaned: 0.5 },
    }]]),
  } };
  const view = render(<Canvas {...props} connectionMetric="sentAttemptsPerSecond" />);
  const badge = await screen.findByTestId("canvas-edge-label-gateway-to-middle");
  expect(badge.textContent).toContain("Sent attempts 40");
  view.rerender(<Canvas {...props} connectionMetric="timeoutRate" />);
  expect(badge.textContent).toContain("Timeout share 25%");
  view.rerender(<Canvas {...props} connectionMetric="meanOrphaned" />);
  expect(badge.textContent).toContain("Orphaned attempts 0.5");
});


it("does not move selected nodes when arrow keys are used on a variant diagnostic badge", async () => {
  const onCommand = vi.fn();
  const warning = { code: "LINT", severity: "WARNING" as const, message: "Budget", variant: "baseline" };
  render(<Canvas catalog={catalog} model={model} layout={layout} selected={["gateway"]} onSelect={vi.fn()}
    editable onCommand={onCommand} variantElementDiagnostics={new Map([["gateway", [warning]]])} />);
  const badge = await screen.findByRole("button", { name: "Warnings in variants: Baseline" });
  badge.focus();
  fireEvent.keyDown(badge, { key: "ArrowRight" });
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByTestId("rf__node-gateway").style.transform).toBe("translate(260px,100px)");
});


it("keeps metric rows and edge labels while empty or stale playback values are loading", async () => {
  const summaryResults = canvasResults(summary, model, "baseline", "p0", catalog)!;
  const frame: CanvasResults = { ...summaryResults, window: 31 };
  const props = { catalog, model, layout, onCommand: vi.fn(), onSelect: vi.fn(), selected: [] };
  const { rerender } = render(<Canvas {...props} results={frame} />);
  const metrics = await screen.findByTestId("canvas-results-gateway");
  const lines = Array.from(metrics.querySelectorAll(".block-result-text")).map(child => child.textContent);
  const edge = screen.getByTestId("canvas-edge-label-client-to-gateway").querySelector(".canvas-edge-results")!;
  const label = edge.textContent;
  rerender(<Canvas {...props} results={{ ...frame, pending: "Loading playback series" }} />);
  expect(Array.from(metrics.querySelectorAll(".block-result-text")).map(child => child.textContent)).toEqual(lines);
  expect(metrics.getAttribute("aria-busy")).toBe("true");
  expect(metrics.classList.contains("canvas-metrics--pending")).toBe(true);
  expect(metrics.firstElementChild?.getAttribute("title")).toContain("Loading playback series");
  expect(edge.textContent).toBe(label);
  expect(edge.getAttribute("title")).toContain("Loading playback series");
  expect(edge.classList.contains("canvas-metrics--pending")).toBe(true);
  rerender(<Canvas {...props} results={{ ...frame, window: undefined, pending: "Loading playback series" }} />);
  expect(metrics.children).toHaveLength(3);
  expect(metrics.classList.contains("canvas-metrics--empty")).toBe(true);
  expect(edge.classList.contains("canvas-metrics--empty")).toBe(true);
  rerender(<Canvas {...props} results={{ ...frame, window: 32 }} />);
  expect(metrics.getAttribute("aria-busy")).toBeNull();
  expect(metrics.classList.contains("canvas-metrics--pending")).toBe(false);
  expect(edge.classList.contains("canvas-metrics--empty")).toBe(false);
});


it("shows a muted wiring hint while preserving parameter and cycle error badges", async () => {
  const unreachable = { code: "TOPOLOGY_GRAPH", severity: "ERROR" as const, message: "Not reachable", path: "gateway",
    args: { reason: "unreachable", service: "gateway" } };
  const props = { catalog, model, layout, selected: [], onSelect: vi.fn(), onCommand: vi.fn() };
  const view = render(<Canvas {...props} elementDiagnostics={new Map([["gateway", [unreachable]]])} />);
  const node = await screen.findByTestId("rf__node-gateway");
  expect(node.textContent).toContain("Connect this block to the model");
  expect(node.querySelector(".diagnostic--error")).toBeNull();
  const parameter = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "Invalid handlers", path: "gateway" };
  view.rerender(<Canvas {...props} elementDiagnostics={new Map([["gateway", [unreachable, parameter]]])} />);
  expect(node.querySelector(".diagnostic--error")?.getAttribute("aria-label")).toBe("1 problems: error");
  expect(node.textContent).toContain("Connect this block to the model");
  view.rerender(<Canvas {...props} elementDiagnostics={new Map([["gateway", [{ ...unreachable, args: { reason: "cycle", service: "gateway" } }]]])} />);
  expect(node.querySelector(".diagnostic--error")).not.toBeNull();
  expect(node.textContent).not.toContain("Connect this block to the model");
  view.rerender(<Canvas {...props} elementDiagnostics={new Map()} />);
  expect(node.textContent).not.toContain("Connect this block to the model");
});


it("hints disconnected blocks even when a missing request only has a global diagnostic", async () => {
  const detached = { ...model, connections: [] };
  render(<Canvas catalog={catalog} model={detached} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  const nodes = await screen.findAllByTestId("block-node");
  for (const node of nodes) expect(node.textContent).toContain("Connect this block to the model");
});

it("marks only fault targets including replica groups and connection copies", async () => {
  const { courseData } = await import("../experiment/course");
  const run = { ...experiment, faults: [
    { target: "gateway#2", from: "0ms", to: "1s", kind: "unavailable" },
    { target: "gateway-to-middle#2", from: "200ms", to: "700ms", kind: "slowdown", multiplier: 2 },
  ] };
  const onFault = vi.fn();
  const grouped = structuredClone(model);
  grouped.blocks.gateway.params.replicas = 2;
  render(<Canvas catalog={catalog} model={grouped} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()}
    faults={courseData(grouped, run, catalog).faults} onFault={onFault} />);
  const gateway = await screen.findByTestId("rf__node-gateway");
  expect(gateway.querySelector(".fault-badge")?.getAttribute("title")).toContain("gateway#2");
  expect(screen.getByTestId("rf__node-middle").querySelector(".fault-badge")).toBeNull();
  expect(screen.getByTestId("rf__node-dependency").querySelector(".fault-badge")).toBeNull();
  const edge = screen.getByTestId("canvas-edge-label-gateway-to-middle");
  const badge = edge.querySelector<HTMLButtonElement>(".fault-badge")!;
  expect(badge.title).toBe("gateway#2 → middle · Slowdown 2× · 200–700 ms");
  fireEvent.click(badge);
  expect(onFault).toHaveBeenCalledWith(1);
});

it("preserves the viewport when a keyboard node move expands diagram bounds", async () => {
  const onCommand = vi.fn();
  const props = { catalog, model, layout, selected: ["dependency"], onSelect: vi.fn(), onCommand, editable: true };
  const { container, rerender } = render(<Canvas {...props} />);
  const node = await screen.findByTestId("rf__node-dependency");
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport")!;
  await waitFor(() => { expect(viewport.style.transform).not.toContain("scale(1)"); });
  const before = viewport.style.transform;
  fireEvent.keyDown(node, { key: "ArrowRight" });
  expect(onCommand).toHaveBeenCalled();
  const moved = structuredClone(layout);
  moved.positions.dependency = { x: 1200, y: 100 };
  await act(async () => {
    rerender(<Canvas {...props} layout={moved} />);
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  expect(node.style.transform).toContain("1200px");
  expect(viewport.style.transform).toBe(before);
});

it("preserves explicit fitting when connection labels grow and refits only on the next request", async () => {
  const observer = globalThis.ResizeObserver;
  const deliveries = new Map<Element, () => void>();
  globalThis.ResizeObserver = class extends observer {
    private deliver: (target: Element) => void;
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      this.deliver = target => callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this);
    }
    observe(target: Element) {
      super.observe(target);
      if (target.classList.contains("canvas-edge-label")) deliveries.set(target, () => this.deliver(target));
    }
  };
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
  let labelHeight = 80;
  height.mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("canvas-edge-label") ? labelHeight : 80;
  });
  try {
    const { container } = render(<Canvas catalog={catalog} model={model} layout={layout} selected={[]}
      onSelect={vi.fn()} onCommand={vi.fn()} editable />);
    const viewport = () => container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    await waitFor(() => { expect(viewport()).not.toContain("scale(1)"); });
    await waitFor(() => { expect(deliveries.size).toBeGreaterThan(0); });
    fireEvent.click(screen.getByRole("button", { name: "Fit View" }));
    const fitted = viewport();
    await act(async () => {
      labelHeight = 240;
      deliveries.forEach(deliver => deliver());
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    expect(viewport()).toBe(fitted);
    fireEvent.click(screen.getByRole("button", { name: "Fit View" }));
    await waitFor(() => { expect(viewport()).not.toBe(fitted); });
  } finally {
    height.mockRestore();
    globalThis.ResizeObserver = observer;
  }
});

it("preserves the viewport after a palette drag and cancellation while keeping explicit fitting available", async () => {
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
  try {
    const props = { catalog, model, layout, selected: [], onSelect: vi.fn(), onCommand: vi.fn(), editable: true };
    const { container, rerender } = render(<Canvas {...props} key="first-experiment" />);
    const viewport = () => container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    const resize = async (value: number) => {
      await act(async () => {
        height.mockReturnValue(value);
        fireEvent(window, new Event("resize"));
        await new Promise(resolve => requestAnimationFrame(resolve));
      });
    };
    await waitFor(() => { expect(viewport()).not.toContain("scale(1)"); });
    const initial = viewport();
    await resize(160);
    expect(viewport()).not.toBe(initial);
    const beforeDrag = viewport();
    const flow = container.querySelector(".react-flow")!;
    fireEvent.dragOver(flow, { dataTransfer: { types: ["application/resilience-lab-block"] } });
    await resize(320);
    expect(viewport()).toBe(beforeDrag);
    fireEvent.dragLeave(flow);
    await resize(480);
    expect(viewport()).toBe(beforeDrag);
    expect(props.onCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fit View" }));
    await waitFor(() => { expect(viewport()).not.toBe(beforeDrag); });
    const fitted = viewport();
    await resize(640);
    expect(viewport()).toBe(fitted);
    rerender(<Canvas {...props} key="other-experiment" />);
    await waitFor(() => { expect(viewport()).not.toBe(fitted); });
    const reopened = viewport();
    await resize(800);
    expect(viewport()).not.toBe(reopened);
  } finally { height.mockRestore(); }
});

it("preserves the viewport after an explicit click on an edge label", async () => {
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
  try {
    const props = { catalog, model, layout, selected: [], onSelect: vi.fn(), onCommand: vi.fn(), editable: true };
    const { container } = render(<Canvas {...props} />);
    const viewport = () => container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    const resize = async (value: number) => {
      await act(async () => {
        height.mockReturnValue(value);
        fireEvent(window, new Event("resize"));
        await new Promise(resolve => requestAnimationFrame(resolve));
      });
    };
    await waitFor(() => { expect(viewport()).not.toContain("scale(1)"); });
    const initial = viewport();
    await resize(320);
    expect(viewport()).not.toBe(initial);
    const before = viewport();
    const element = await screen.findByTestId("canvas-edge-label-gateway-to-middle");
    fireEvent.mouseDown(element);
    fireEvent.mouseUp(element);
    fireEvent.click(element);
    await resize(160);
    expect(viewport()).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Fit View" }));
    await waitFor(() => { expect(viewport()).not.toBe(before); });
  } finally { height.mockRestore(); }
});

it("shows block and every connection type description through HelpHint without exposing notes", async () => {
  const annotated = structuredClone(model);
  annotated.blocks.gateway.description = "  Gateway explanation  ";
  annotated.blocks.gateway.notes = "Private editing notes";
  annotated.connections.forEach(connection => { connection.description = `${connection.id} explanation`; connection.notes = "Connection notes"; });
  annotated.connections[2].type = "route";
  render(<Canvas catalog={catalog} model={annotated} layout={layout} selected={[]}
    onSelect={vi.fn()} onCommand={vi.fn()} />);
  const node = await screen.findByTestId("rf__node-gateway");
  fireEvent.click(within(node).getByRole("button", { name: "More about: gateway" }));
  expect(screen.getByRole("tooltip").textContent).toBe("  Gateway explanation  ");
  expect(node.textContent).not.toContain("Private editing notes");
  fireEvent.keyDown(window, { key: "Escape" });
  for (const connection of annotated.connections) {
    const label = screen.getByTestId(`canvas-edge-label-${connection.id}`);
    fireEvent.click(within(label).getByRole("button", { name: `More about: ${connection.from} → ${connection.to} (${connection.id})` }));
    expect(screen.getByRole("tooltip").textContent).toBe(`${connection.id} explanation`);
    expect(label.textContent).not.toContain("Connection notes");
    fireEvent.keyDown(window, { key: "Escape" });
  }
  expect(within(screen.getByTestId("rf__node-client")).queryByRole("button", { name: "More about: client" })).toBeNull();
});


it("renders authored dimensions, selected resize handles and resets the automatic footprint", async () => {
  const manual = { ...layout, sizes: { gateway: { width: 320, height: 300 } } };
  const props = { catalog, model, selected: ["gateway"], onSelect: vi.fn(), onCommand: vi.fn(), editable: true };
  const { rerender } = render(<Canvas {...props} layout={manual} />);
  const gateway = await screen.findByTestId("rf__node-gateway");
  expect(gateway.style.width).toBe("320px");
  expect(gateway.style.height).toBe("300px");
  expect(gateway.querySelector(".block-shape")?.getAttribute("style")).toContain("width: 320px");
  expect(gateway.querySelectorAll(".react-flow__resize-control.handle")).toHaveLength(4);
  expect(screen.getByTestId("rf__node-middle").querySelector(".react-flow__resize-control")).toBeNull();
  rerender(<Canvas {...props} layout={layout} />);
  expect(gateway.style.width).toBe("");
  expect(gateway.style.height).toBe("");
  expect((gateway.querySelector(".block-shape") as HTMLElement).style.width).toBe("");
  expect(props.onCommand).not.toHaveBeenCalled();
});

it.each([{ variant: experiment.variants[0] }, { disabled: true }, { editable: false }])("hides resize actions for read-only or disabled nodes: %s", async state => {
  render(<Canvas catalog={catalog} model={model} layout={layout} selected={["gateway"]} onSelect={vi.fn()} onCommand={vi.fn()} editable {...state} />);
  const gateway = await screen.findByTestId("rf__node-gateway");
  expect(gateway.querySelector(".react-flow__resize-control")).toBeNull();
});


function resizeMouse(type: string, target: Element | Window, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  // Vitest's Window proxy is not accepted by jsdom's UIEvent constructor.
  Object.defineProperty(event, "view", { value: window });
  fireEvent(target, event);
}

it("commits a native left resize once on release and keeps position and dimensions atomic", async () => {
  const onCommand = vi.fn();
  render(<Canvas catalog={catalog} model={model} layout={layout} selected={["gateway"]} onSelect={vi.fn()} onCommand={onCommand} editable />);
  const gateway = await screen.findByTestId("rf__node-gateway");
  const handle = gateway.querySelector(".react-flow__resize-control.handle.left.top")!;
  expect(handle).not.toBeNull();
  resizeMouse("mousedown", handle, 20, 20);
  resizeMouse("mousemove", window, -180, -180);
  expect(onCommand).not.toHaveBeenCalled();
  resizeMouse("mouseup", window, -180, -180);
  expect(onCommand).toHaveBeenCalledTimes(1);
  const after = (onCommand.mock.calls[0][0] as EditorCommand)({ model, layout, experiment });
  expect(after.layout.positions.gateway.x).toBeLessThan(layout.positions.gateway.x);
  expect(after.layout.positions.gateway.y).toBeLessThan(layout.positions.gateway.y);
  expect(after.layout.sizes.gateway.width).toBeGreaterThan(180);
  expect(after.layout.sizes.gateway.height).toBeGreaterThan(80);
});

it.each(["Escape", "blur", "pointercancel"])("discards a native resize on %s without writing a command", async cancel => {
  const onCommand = vi.fn();
  render(<Canvas catalog={catalog} model={model} layout={layout} selected={["gateway"]} onSelect={vi.fn()} onCommand={onCommand} editable />);
  const gateway = await screen.findByTestId("rf__node-gateway");
  const handle = gateway.querySelector(".react-flow__resize-control.handle.right.bottom")!;
  resizeMouse("mousedown", handle, 20, 20);
  resizeMouse("mousemove", window, 220, 220);
  expect(gateway.style.width).not.toBe("");
  if (cancel === "Escape") fireEvent.keyDown(window, { key: "Escape" });
  else fireEvent(window, new Event(cancel));
  expect(gateway.style.width).toBe("");
  resizeMouse("mouseup", window, 220, 220);
  expect(onCommand).not.toHaveBeenCalled();
});


it.each(["disabled", "selection", "document"])("cannot resurrect an interrupted resize after %s changes", async interruption => {
  const props = { catalog, model, layout, selected: ["gateway"], onSelect: vi.fn(), onCommand: vi.fn(), editable: true };
  const { rerender } = render(<Canvas {...props} />);
  const gateway = await screen.findByTestId("rf__node-gateway");
  resizeMouse("mousedown", gateway.querySelector(".react-flow__resize-control.handle.right.bottom")!, 20, 20);
  resizeMouse("mousemove", window, 220, 220);
  expect(gateway.style.width).not.toBe("");
  rerender(<Canvas {...props} {...(interruption === "disabled" ? { disabled: true } : interruption === "selection" ? { selected: [] } : { layout: structuredClone(layout) })} />);
  expect(gateway.style.width).toBe("");
  rerender(<Canvas {...props} />);
  expect(gateway.style.width).toBe("");
  resizeMouse("mouseup", window, 220, 220);
  expect(props.onCommand).not.toHaveBeenCalled();
});

it("offers segment and bend controls on selected model edges and hides them on variants", async () => {
  const onCommand = vi.fn();
  const props = { catalog, model, layout, selected: ["gateway-to-middle"], onSelect: vi.fn(), onCommand, editable: true };
  const { rerender } = render(<Canvas {...props} />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: /Move segment .*gateway-to-middle/ }).length).toBeGreaterThan(0));
  expect(screen.getAllByRole("button", { name: /Move bend .*gateway-to-middle/ }).length).toBeGreaterThan(0);
  expect(onCommand).not.toHaveBeenCalled();
  rerender(<Canvas {...props} variant={experiment.variants[0]} />);
  expect(screen.queryByRole("button", { name: /Move segment/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Move bend/ })).toBeNull();
});

it("routes saved model points on readonly variants and includes them in common Fit bounds", async () => {
  const points = [{ x: 400, y: -1800 }, { x: 2200, y: -1800 }];
  const manual = { ...layout, edges: { "gateway-to-middle": { points } } };
  const calculate = vi.spyOn(edgeGeometry, "layoutEdges");
  try {
    render(<Canvas catalog={catalog} model={model} layout={manual} selected={["gateway-to-middle"]} onSelect={vi.fn()} onCommand={vi.fn()}
      variant={experiment.variants[0]} editable={false} />);
    await waitFor(() => {
      const route = calculate.mock.results.at(-1)?.value?.get("gateway-to-middle");
      expect(route?.points).toEqual(expect.arrayContaining(points));
      expect(route?.bounds.y).toBeLessThanOrEqual(-1800);
      expect(route?.bounds.x + route?.bounds.width).toBeGreaterThanOrEqual(2200);
    });
    expect(screen.queryByRole("button", { name: /Move segment/ })).toBeNull();
  } finally { calculate.mockRestore(); }
});

it.each(["variant", "layout"])("creates one manual route and discards previews on %s changes", async reason => {
  const onCommand = vi.fn();
  const props = { catalog, model, layout, selected: ["gateway-to-middle"], onSelect: vi.fn(), onCommand, editable: true };
  const { rerender, container } = render(<Canvas {...props} />);
  const path = () => container.querySelector<SVGPathElement>('#gateway-to-middle')!.getAttribute("d");
  const handle = await screen.findByRole("button", { name: "Move bend 1 of gateway-to-middle" });
  const pointer = (type: string, x: number, y: number, target: EventTarget = window) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 7 });
    act(() => { target.dispatchEvent(event); });
  };
  const before = path();
  pointer("pointerdown", 100, 100, handle);
  pointer("pointermove", 130, 140);
  expect(path()).not.toBe(before);
  expect(onCommand).not.toHaveBeenCalled();
  pointer("pointerup", 130, 140);
  expect(onCommand).toHaveBeenCalledTimes(1);
  const after = (onCommand.mock.lastCall![0] as EditorCommand)({ model, layout, experiment });
  expect(after.layout.edges["gateway-to-middle"].points.length).toBeGreaterThan(0);
  expect(after.model).toBe(model);
  pointer("pointerdown", 100, 100, screen.getByRole("button", { name: "Move bend 1 of gateway-to-middle" }));
  pointer("pointermove", 130, 140);
  rerender(<Canvas {...props} layout={{ ...layout, edges: {} }} variant={reason === "variant" ? experiment.variants[0] : undefined} />);
  pointer("pointerup", 130, 140);
  expect(onCommand).toHaveBeenCalledTimes(1);
  rerender(<Canvas {...props} />);
  expect(path()).toBe(before);
});
