import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { mockReactFlowDom } from "../test/reactFlow";
import { Canvas } from "./Canvas";
import { VariantTabs } from "./VariantTabs";
import { canvasResults, type CanvasResults } from "../results/canvasResults";
import { summary } from "../test/fixtures";
import { setLanguage } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";

beforeAll(mockReactFlowDom);

describe("Canvas", () => {
  it.each([1, 4, 10])("labels service parameters before their values with %s handlers", async handlers => {
    setLanguage("ru");
    try {
      const configured = { ...model, blocks: { ...model.blocks,
        gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers } },
      } };
      render(<Canvas catalog={localizeCatalog(catalog)} onCommand={vi.fn()} model={configured} layout={layout}
        selected={[]} onSelect={vi.fn()} />);
      const node = await screen.findByTestId("rf__node-gateway");
      expect(node.querySelector(".block-summary")?.textContent?.replace(/\s+/g, " ").trim())
        .toBe(`обработчики: ${handlers} · очередь: 16 · среднее: 1ms`);
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
    expect(screen.getByText("120/s · deadline 250ms")).toBeTruthy();
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

  it("marks the controlled active variant and falls back to its id without a label", () => {
    render(<VariantTabs variants={[{ id: "plain", overrides: {} }]} active="plain" onSelect={vi.fn()} onInspect={vi.fn()} onCommand={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "plain" }).getAttribute("aria-selected")).toBe("true");
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
    results={canvasResults(summary, model, "baseline", "p0")} />);
  expect(await screen.findByTestId("canvas-results-gateway")).toBeTruthy();
  expect(screen.queryByTestId("canvas-results-added")).toBeNull();
  expect(screen.getByTestId("canvas-edge-label-new-call").textContent).not.toContain("Amplification");
  expect(screen.getByTestId("canvas-edge-label-gateway-to-middle").textContent).not.toContain("Amplification");
  expect(screen.getByTestId("canvas-edge-label-client-to-gateway").textContent).toContain("Amplification 1.2×");
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
      from: "gateway", to: "middle", type: "call", amplification: 2.5,
      sentAttemptsPerSecond: 40, timeoutRate: 0.25, meanOrphaned: 0.5,
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
  const badge = await screen.findByRole("button", { name: "Warnings in variants: baseline" });
  badge.focus();
  fireEvent.keyDown(badge, { key: "ArrowRight" });
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByTestId("rf__node-gateway").style.transform).toBe("translate(260px,100px)");
});


it("keeps metric rows and edge labels while empty or stale playback values are loading", async () => {
  const summaryResults = canvasResults(summary, model, "baseline", "p0")!;
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
