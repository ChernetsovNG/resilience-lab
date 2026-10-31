import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
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

beforeAll(mockReactFlowDom);

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
  expect(screen.getByTestId("canvas-param-gateway-processing.mean").querySelector("del")?.textContent).toBe("1ms");
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
  const queue = [...metrics.children].find(row => row.textContent?.startsWith("Mean queue"))!;
  expect(queue.getAttribute("title")).toContain("Mean queue 9,999,999.99");
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
        .toEqual([`обработчики: ${handlers}`, "очередь: 16", "среднее: 1ms"]);
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
    expect(screen.getByTestId("canvas-param-gateway-processing.mean").textContent).toBe("1ms");
    expect(screen.getByTestId("canvas-param-client-load.points.0.rate").textContent).toBe("120/s");
    expect(screen.getByTestId("canvas-param-client-deadline").textContent).toBe("250ms");
    fireEvent.click(screen.getByTestId("rf__node-gateway"));
    expect(onSelect).toHaveBeenCalledWith(["gateway"]);
  });

  it("labels call connections, selects an edge and clears selection on the pane", async () => {
    const onSelect = vi.fn();
    const { container } = render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={onSelect} />);
    const edge = await screen.findByTestId("rf__edge-gateway-to-middle");
    expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("80ms");
    expect(screen.getByTestId("canvas-param-gateway-to-middle-attempts").textContent).toBe("3");
    expect(screen.getByTestId("canvas-param-middle-to-dependency-timeout").textContent).toBe("60ms");
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
    rerender(<Canvas catalog={catalog} onCommand={vi.fn()} {...props} layout={{ schemaVersion: 1, positions: { client: { x: 40, y: 60 } } }} />);
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

    expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("80ms");
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
  expect(badge.textContent).toContain("Orphaned work 0.5");
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
  const lines = Array.from(metrics.children).map(child => child.textContent);
  const edge = screen.getByTestId("canvas-edge-label-client-to-gateway").querySelector(".canvas-edge-results")!;
  const label = edge.textContent;
  rerender(<Canvas {...props} results={{ ...frame, pending: "Loading playback series" }} />);
  expect(Array.from(metrics.children).map(child => child.textContent)).toEqual(lines);
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
  expect(badge.title).toBe("gateway#2 → middle · Slowdown 2× · 0.2–0.7 s");
  fireEvent.click(badge);
  expect(onFault).toHaveBeenCalledWith(1);
});
