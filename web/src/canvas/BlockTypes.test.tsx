import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Catalog, ModelFile } from "../api/apiTypes";
import { setLanguage } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import fullCatalog from "../test/catalog.json";
import { catalog, layout, model } from "../test/fixtures";
import { mockReactFlowDom } from "../test/reactFlow";
import { Canvas } from "./Canvas";

beforeAll(mockReactFlowDom);
afterEach(() => { setLanguage("en"); localStorage.clear(); });

it.each([undefined, 1, 3])("shows a service stack and count only for replicas > 1 (%s)", async replicas => {
  const params = { ...model.blocks.middle.params, ...(replicas === undefined ? {} : { replicas }) };
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={{ ...model, blocks: { middle: { type: "service", params } } }}
    layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  const node = await screen.findByTestId("rf__node-middle");
  expect(node.querySelector(".block-shape--replicas") !== null).toBe(replicas === 3);
  expect(within(node).queryByText("×3") !== null).toBe(replicas === 3);
});

it("does not draw non-service blocks as replica groups", async () => {
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={{ ...model, blocks: { middle: { type: "database", params: { replicas: 3 } } } }}
    layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  const node = await screen.findByTestId("rf__node-middle");
  expect(node.querySelector(".block-shape--replicas")).toBeNull();
  expect(within(node).queryByText("×3")).toBeNull();
});

const blocks = [
  { type: "client", shape: "person", params: model.blocks.client.params, paths: ["load.points.0.rate", "deadline"] },
  { type: "service", shape: "card", params: model.blocks.gateway.params, paths: ["handlers", "queue", "processing.mean"] },
  { type: "database", shape: "cylinder", params: { maxConnections: 3, queue: 4, processing: { kind: "fixed", mean: "5ms" } }, paths: ["maxConnections", "queue", "processing.mean"] },
  { type: "pooler", shape: "double", params: { maxClientConnections: 1000, poolSize: 20, waitTimeout: "5s" }, paths: ["maxClientConnections", "poolSize", "waitTimeout"] },
  { type: "router", shape: "circle", params: { policy: "random" }, paths: ["policy"] },
];

it.each(blocks)("shows $type parameters and its type icon inside the $shape silhouette", async ({ type, shape, params, paths }) => {
  const snapshot: ModelFile = { ...model, blocks: { ...model.blocks, middle: { type, params } } };
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={snapshot} layout={layout} selected={[]}
    onSelect={vi.fn()} onCommand={vi.fn()} parametersEditable />);
  const node = await screen.findByTestId("rf__node-middle");
  expect(node.querySelector(`.block-shape--${shape}`)).not.toBeNull();
  const icon = node.querySelector(".block-type-icon");
  expect(icon?.getAttribute("title")).toBe(fullCatalog.types.find(item => item.id === type)!.title);
  expect(icon?.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
  const rows = node.querySelectorAll(".block-summary > .block-param");
  expect(rows).toHaveLength(paths.length);
  for (const path of paths) expect(within(node).getByTestId(`canvas-param-middle-${path}`)).toBeTruthy();
  expect(node.querySelector(".block-node-header")?.textContent?.trim()).toBe("middle");
});

it("keeps unknown types in a normal card with a fallback icon and no type subtitle", async () => {
  const custom = { ...catalog, types: [...catalog.types, { ...catalog.types[1], id: "worker", title: "Worker" }] };
  render(<Canvas catalog={custom} model={{ ...model, blocks: { middle: { type: "worker", params: {} } } }}
    layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} />);
  const node = await screen.findByTestId("rf__node-middle");
  expect(node.querySelector(".block-shape--card")).not.toBeNull();
  expect(node.querySelector(".block-type-icon")?.textContent).toBe("W");
  expect(node.querySelector(".block-summary")).toBeNull();
});

it.each([
  { type: "database", path: "maxConnections", input: "7", value: 7 },
  { type: "database", path: "queue", input: "9", value: 9 },
  { type: "database", path: "processing.mean", input: "8ms", value: "8ms" },
  { type: "pooler", path: "maxClientConnections", input: "500", value: 500 },
  { type: "pooler", path: "poolSize", input: "12", value: 12 },
  { type: "pooler", path: "waitTimeout", input: "40ms", value: "40ms" },
  { type: "router", path: "policy", input: "leastInFlight", value: "leastInFlight" },
  { type: "client", path: "deadline", input: "400ms", value: "400ms" },
])("commits $type parameter $path once through the existing parameter command", async ({ type, path, input, value }) => {
  const block = blocks.find(block => block.type === type)!;
  const onParam = vi.fn();
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={{ ...model, blocks: { middle: { type, params: block.params } } }}
    layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} onParam={onParam} parametersEditable />);
  fireEvent.doubleClick(await screen.findByTestId(`canvas-param-middle-${path}`));
  const editor = screen.queryByRole("combobox") ?? screen.getByRole("textbox");
  fireEvent.change(editor, { target: { value: input } });
  if (editor.tagName === "INPUT") fireEvent.submit(editor.closest("form")!);
  fireEvent.blur(editor);
  expect(onParam).toHaveBeenCalledExactlyOnceWith("middle", path, value);
});

it("edits single-point intensity as a whole load override, preserving the point time", async () => {
  const onParam = vi.fn();
  const params = { ...model.blocks.client.params, load: { points: [{ time: "2s", rate: "120/s" }] } };
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={{ ...model, blocks: { middle: { type: "client", params } } }}
    layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} onParam={onParam} parametersEditable />);
  fireEvent.doubleClick(await screen.findByTestId("canvas-param-middle-load.points.0.rate"));
  const editor = screen.getByRole("textbox");
  fireEvent.change(editor, { target: { value: "30/s" } });
  fireEvent.submit(editor.closest("form")!);
  expect(onParam).toHaveBeenCalledExactlyOnceWith("middle", "load", { points: [{ time: "2s", rate: "30/s" }] });
});

it("cancels inline policy selection with Escape without changing the document", async () => {
  const onParam = vi.fn();
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={{ ...model, blocks: { middle: { type: "router", params: { policy: "random" } } } }}
    layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} onParam={onParam} parametersEditable />);
  fireEvent.doubleClick(await screen.findByTestId("canvas-param-middle-policy"));
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(onParam).not.toHaveBeenCalled();
});

it("keeps multi-point intensity as a profile while its deadline remains editable", async () => {
  const onParam = vi.fn();
  const params = { ...model.blocks.client.params, load: { points: [{ time: "0s", rate: "10/s" }, { time: "5s", rate: "50/s" }] } };
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={{ ...model, blocks: { middle: { type: "client", params } } }}
    layout={layout} selected={[]} onSelect={vi.fn()} onCommand={vi.fn()} onParam={onParam} parametersEditable />);
  const node = await screen.findByTestId("rf__node-middle");
  expect(within(node).getByText("Load profile")).toBeTruthy();
  expect(screen.queryByTestId("canvas-param-middle-load.points.0.rate")).toBeNull();
  fireEvent.doubleClick(within(node).getByTestId("canvas-param-middle-deadline"));
  const editor = screen.getByRole("textbox");
  fireEvent.change(editor, { target: { value: "1s" } });
  fireEvent.submit(editor.closest("form")!);
  expect(onParam).toHaveBeenCalledExactlyOnceWith("middle", "deadline", "1s");
});

it.each(["en", "ru"] as const)("shows one compact pool/balancing label in %s only when configured", async language => {
  setLanguage(language);
  const snapshot = structuredClone(model);
  snapshot.blocks.middle.params.replicas = 3;
  const params = snapshot.connections[1].params;
  params.pool = { size: 10, acquireTimeout: "5ms" };
  params.balancing = "leastInFlight";
  render(<Canvas catalog={localizeCatalog(fullCatalog as Catalog)} model={snapshot} layout={layout} selected={[]}
    onSelect={vi.fn()} onCommand={vi.fn()} />);
  const label = await screen.findByTestId("canvas-edge-label-gateway-to-middle");
  expect(label.textContent).toContain(language === "en" ? "pool 10" : "пул 10");
  expect(label.textContent).toContain(language === "en" ? "Fewest active requests" : "Меньше активных запросов");
  expect(label.querySelectorAll(".canvas-edge-parameters")).toHaveLength(1);
  expect(screen.getByTestId("canvas-edge-label-middle-to-dependency").textContent).not.toMatch(/pool|пул|Fewest active requests|Меньше активных запросов/);
});
