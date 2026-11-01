import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import { Canvas } from "./Canvas";
import { layout, model } from "../test/fixtures";
import fullCatalog from "../test/catalog.json";
import type { Catalog } from "../api/apiTypes";
import { localizeCatalog } from "../i18n/catalog";
import { applyOverrides } from "../workspace/params";
import { mockReactFlowDom } from "../test/reactFlow";

beforeAll(mockReactFlowDom);
const catalog = localizeCatalog(fullCatalog as Catalog);

it("shows policies on their owning elements and opens their inspector fields", async () => {
  const snapshot = structuredClone(model);
  snapshot.blocks.gateway.params.rateLimit = { rate: 10, burst: 10 };
  snapshot.blocks.middle.params.replicas = 3;
  snapshot.blocks.middle.params.healthCheck = { interval: "1s" };
  const call = snapshot.connections.find(edge => edge.id === "gateway-to-middle")!;
  call.params = { ...call.params, circuitBreaker: {}, fallback: {}, retryBudget: {}, outlierDetection: {} };
  const onOpen = vi.fn();
  render(<Canvas model={snapshot} catalog={catalog} layout={layout} selected={[]} onSelect={vi.fn()}
    onSelectChange={onOpen} onCommand={vi.fn()} />);
  const edge = await screen.findByTestId("canvas-policies-gateway-to-middle");
  expect(within(edge).getByRole("button", { name: "Circuit breaker" })).toBeDefined();
  expect(within(edge).getByRole("button", { name: "Fallback" })).toBeDefined();
  const more = within(edge).getByText("+2");
  expect(more.title).toContain("Retry budget");
  expect(more.title).toContain("Outlier detection");
  fireEvent.click(within(edge).getByRole("button", { name: "Circuit breaker" }));
  expect(onOpen).toHaveBeenLastCalledWith("gateway-to-middle", "circuitBreaker");
  fireEvent.click(more);
  fireEvent.click(within(edge).getByRole("button", { name: "Retry budget" }));
  expect(onOpen).toHaveBeenLastCalledWith("gateway-to-middle", "retryBudget");
  expect(within(screen.getByTestId("rf__node-gateway")).getByRole("button", { name: "Rate limit" })).toBeDefined();
  expect(within(screen.getByTestId("rf__node-middle")).getByRole("button", { name: "Health check" })).toBeDefined();
});

it("uses effective variant policies and keeps models without policies unchanged", async () => {
  const variant = { id: "policies", overrides: { "gateway.rateLimit": {}, "gateway-to-middle.circuitBreaker": {} } };
  const props = { catalog, layout, selected: [], onSelect: vi.fn(), onCommand: vi.fn() };
  const { rerender } = render(<Canvas {...props} model={model} />);
  await screen.findByTestId("rf__node-gateway");
  expect(screen.queryByTestId("canvas-policies-gateway")).toBeNull();
  rerender(<Canvas {...props} model={applyOverrides(model, variant.overrides, catalog)} variant={variant} />);
  expect(await screen.findByTestId("canvas-policies-gateway")).toBeDefined();
  expect(screen.getByTestId("canvas-policies-gateway-to-middle")).toBeDefined();
  rerender(<Canvas {...props} model={applyOverrides(model, { ...variant.overrides, "gateway.rateLimit": null }, catalog)} />);
  expect(screen.queryByTestId("canvas-policies-gateway")).toBeNull();
});

it("only shows outlier detection on routers and calls into replica groups", async () => {
  const snapshot = structuredClone(model);
  snapshot.blocks.middle = { type: "router", params: { policy: "roundRobin", outlierDetection: {} } };
  snapshot.blocks.gateway.params.circuitBreaker = {};
  snapshot.connections[1].params.outlierDetection = {};
  render(<Canvas model={snapshot} catalog={catalog} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  expect(within(await screen.findByTestId("rf__node-middle")).getByRole("button", { name: "Outlier detection" })).toBeDefined();
  expect(screen.queryByTestId("canvas-policies-gateway")).toBeNull();
  expect(screen.queryByTestId("canvas-policies-gateway-to-middle")).toBeNull();
});

it("blocks policy navigation while an invalid draft disables the canvas", async () => {
  const snapshot = structuredClone(model);
  snapshot.blocks.gateway.params.rateLimit = {};
  const onOpen = vi.fn();
  render(<Canvas model={snapshot} catalog={catalog} layout={layout} selected={[]} onSelect={vi.fn()} disabled
    onSelectChange={onOpen} onCommand={vi.fn()} />);
  const badge = await screen.findByRole("button", { name: "Rate limit" });
  expect((badge as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(badge);
  expect(onOpen).not.toHaveBeenCalled();
});

it("shows a policy enabled only for an individual replica and opens that replica's field", async () => {
  const snapshot = structuredClone(model);
  snapshot.blocks.gateway.params.replicas = 3;
  snapshot.blocks.gateway.replicaOverrides = { "2": { healthCheck: {} } };
  const onOpen = vi.fn();
  render(<Canvas model={snapshot} catalog={catalog} layout={layout} selected={[]} onSelect={vi.fn()}
    onSelectChange={onOpen} onCommand={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Health check" }));
  expect(onOpen).toHaveBeenLastCalledWith("gateway", "replicaOverrides.2.healthCheck");
});

it("hides a group policy when every replica disables the inherited value", async () => {
  const snapshot = structuredClone(model);
  snapshot.blocks.gateway.params.replicas = 3;
  snapshot.blocks.gateway.params.healthCheck = {};
  snapshot.blocks.gateway.replicaOverrides = { "1": { healthCheck: null }, "2": { healthCheck: null }, "3": { healthCheck: null } };
  render(<Canvas model={snapshot} catalog={catalog} layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  await screen.findByTestId("rf__node-gateway");
  expect(screen.queryByTestId("canvas-policies-gateway")).toBeNull();
});
