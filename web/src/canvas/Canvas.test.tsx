import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { mockReactFlowDom } from "../test/reactFlow";
import { Canvas } from "./Canvas";
import { VariantTabs } from "./VariantTabs";

beforeAll(mockReactFlowDom);

describe("Canvas", () => {
  it("shows finding counts and the greatest severity on blocks and connections", async () => {
    const warning = { code: "LINT_TIMEOUT_BUDGET", severity: "WARNING" as const, message: "Check timeout" };
    render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={vi.fn()} elementDiagnostics={new Map([
      ["gateway", [warning, { ...warning, severity: "ERROR" }]],
      ["gateway-to-middle", [warning]],
    ])} />);
    expect(await screen.findByRole("img", { name: "2 problems: error" })).toBeTruthy();
    expect((await screen.findByTestId("rf__edge-gateway-to-middle")).textContent).toContain("⚠ 1");
  });
  it("draws blocks with key parameters and reports the selection", async () => {
    const onSelect = vi.fn();
    render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={onSelect} />);
    expect(await screen.findAllByTestId("block-node")).toHaveLength(4);
    expect(screen.getByText("4 handlers · queue 16")).toBeTruthy();
    expect(screen.getByText("120/s · deadline 250ms")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rf__node-gateway"));
    expect(onSelect).toHaveBeenCalledWith(["gateway"]);
  });

  it("labels call connections, selects an edge and clears selection on the pane", async () => {
    const onSelect = vi.fn();
    const { container } = render(<Canvas catalog={catalog} onCommand={vi.fn()} model={model} layout={layout} selected={[]} onSelect={onSelect} />);
    const edge = await screen.findByTestId("rf__edge-gateway-to-middle");
    expect(screen.getByText("80ms · 3×")).toBeTruthy();
    expect(screen.getByText("60ms · 3×")).toBeTruthy();
    expect(screen.getByTestId("rf__edge-client-to-gateway").textContent).toBe("");
    fireEvent.click(edge);
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
    expect(await screen.findByText("4 handlers · queue 0")).toBeTruthy();
    expect(await screen.findByText("80ms · 1×")).toBeTruthy();
  });
});

describe("VariantTabs", () => {
  it("puts Model first and switches to every variant, including empty overrides", () => {
    const onSelect = vi.fn();
    render(<VariantTabs variants={experiment.variants} active={null} onSelect={onSelect} />);
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
    render(<VariantTabs variants={[{ id: "plain", overrides: {} }]} active="plain" onSelect={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "plain" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps page navigation disabled while an editable draft is invalid", () => {
    const onSelect = vi.fn();
    render(<VariantTabs variants={experiment.variants} active={null} disabled onSelect={onSelect} />);
    for (const tab of screen.getAllByRole("tab")) {
      expect((tab as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(tab);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
});
