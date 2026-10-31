import { expect, test as base, type Page } from "./fixtures";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExperimentFile, LayoutFile, ModelFile } from "../src/api/apiTypes";
import { selectExperiment } from "./fixtures";

const test = base.extend<{ graph: { directory: string; layout: LayoutFile } }>({
  graph: async ({ page }, provide) => {
    // Capture observer errors before Vite's error overlay can consume the window event.
    await page.addInitScript(() => window.addEventListener("error", event => {
      if (event.message.startsWith("ResizeObserver")) console.error(event.message);
    }));
    const directory = `canvas-graph-${randomUUID()}`;
    const target = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(target);
    const model: ModelFile = JSON.parse(await readFile("../examples/retry-storm/retry-storm.model.json", "utf8"));
    const service = model.blocks.gateway;
    model.blocks = {
      client: model.blocks.client, gateway: service,
      router: { ...structuredClone(service), type: "router", params: { policy: "roundRobin" } },
      "replica-a": structuredClone(service), "replica-b": structuredClone(service),
      database: { ...structuredClone(service), type: "database", params: {
        maxConnections: 4, queue: 16, processing: { kind: "fixed", mean: "1ms" },
      } },
    };
    model.connections = [
      { id: "request", from: "client", to: "gateway", type: "request", params: {} },
      { id: "dispatch", from: "gateway", to: "router", type: "call", params: { timeout: "80ms", attempts: 1 } },
      ...["a", "b"].flatMap(id => [
        { id: `route-${id}`, from: "router", to: `replica-${id}`, type: "route", params: { weight: 1 } },
        { id: `query-${id}`, from: `replica-${id}`, to: "database", type: "call", params: { timeout: "40ms", attempts: 1 } },
      ]),
    ];
    const layout: LayoutFile = { schemaVersion: 1, positions: {
      client: { x: 0, y: 100 }, gateway: { x: 340, y: 100 }, router: { x: 700, y: 100 },
      "replica-a": { x: 1060, y: 0 }, "replica-b": { x: 1060, y: 200 }, database: { x: 1420, y: 100 },
    } };
    const experiment: ExperimentFile = JSON.parse(await readFile("../examples/retry-storm/retry-storm.experiment.json", "utf8"));
    experiment.execution = { ...experiment.execution, replications: 2, measurement: "300ms", window: "50ms" };
    experiment.modelRef = "graph.model.json";
    experiment.layoutRef = "graph.layout.json";
    experiment.variants = [{ id: "baseline", label: "Ветвящийся граф" }];
    experiment.faults = [];
    await Promise.all([
      writeFile(resolve(target, "graph.model.json"), JSON.stringify(model)),
      writeFile(resolve(target, "graph.layout.json"), JSON.stringify(layout)),
      writeFile(resolve(target, "graph.experiment.json"), JSON.stringify(experiment)),
    ]);
    try {
      await page.goto("/");
      await selectExperiment(page, `${directory}/graph.experiment.json`);
      await expect(page.getByTestId("block-node")).toHaveCount(6);
      await provide({ directory, layout });
    } finally { await rm(target, { recursive: true }); }
  },
});

test.use({ locale: "ru-RU", viewport: { width: 1280, height: 800 }, actionTimeout: 10_000 });

async function geometry(page: Page) {
  return page.locator(".react-flow").evaluate(element => {
    const rectangles = [...element.querySelectorAll<HTMLElement>(".react-flow__node")].map(node => ({
      id: node.dataset.id!, width: node.offsetWidth, height: node.offsetHeight, rect: node.getBoundingClientRect().toJSON(),
    }));
    const overlaps = rectangles.flatMap((a, index) => rectangles.slice(index + 1).flatMap(b =>
      Math.min(a.rect.right, b.rect.right) > Math.max(a.rect.left, b.rect.left) + 1 &&
      Math.min(a.rect.bottom, b.rect.bottom) > Math.max(a.rect.top, b.rect.top) + 1 ? [[a.id, b.id]] : []));
    const banner = element.parentElement!.querySelector(".variant-banner")?.getBoundingClientRect();
    const paths = [...element.querySelectorAll<SVGPathElement>(".react-flow__edge-path")];
    const labels = [...element.querySelectorAll<HTMLElement>(".canvas-edge-label")].map(label => {
      const rect = label.getBoundingClientRect();
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const distances = paths.map(path => {
        const matrix = path.getScreenCTM()!;
        let distance = Infinity;
        const length = path.getTotalLength();
        for (let index = 0; index <= 200; index++) {
          const point = path.getPointAtLength(length * index / 200).matrixTransform(matrix);
          distance = Math.min(distance, Math.hypot(point.x - center.x, point.y - center.y));
        }
        return { id: path.closest(".react-flow__edge")!.getAttribute("data-id"), distance };
      });
      const id = label.dataset.testid!.replace("canvas-edge-label-", "");
      return { id, rect: rect.toJSON(), nearest: distances.sort((a, b) => a.distance - b.distance)[0].id,
        nodeOverlaps: rectangles.filter(node => Math.min(rect.right, node.rect.right) > Math.max(rect.left, node.rect.left) &&
          Math.min(rect.bottom, node.rect.bottom) > Math.max(rect.top, node.rect.top)).map(node => node.id),
        bannerOverlap: banner !== undefined && Math.min(rect.right, banner.right) > Math.max(rect.left, banner.left) &&
          Math.min(rect.bottom, banner.bottom) > Math.max(rect.top, banner.top) };
    });
    const labelOverlaps = labels.flatMap((a, index) => labels.slice(index + 1).flatMap(b =>
      Math.min(a.rect.right, b.rect.right) > Math.max(a.rect.left, b.rect.left) &&
      Math.min(a.rect.bottom, b.rect.bottom) > Math.max(a.rect.top, b.rect.top) ? [[a.id, b.id]] : []));
    return { nodes: rectangles.map(({ id, width, height }) => ({ id, width, height })), overlaps, labels, labelOverlaps };
  });
}

async function runGraph(page: Page) {
  await page.getByRole("tab", { name: "Ветвящийся граф", exact: true }).click();
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
  await expect(page.getByTestId("canvas-results-gateway")).toBeVisible();
}

test("branch labels follow their edges and node footprints survive a real run", async ({ page, graph }, testInfo) => {
  const before = await geometry(page);
  await page.screenshot({ path: testInfo.outputPath("graph-editor.png") });
  expect.soft(before.overlaps).toEqual([]);
  for (const label of before.labels) expect.soft(label.nearest, label.id).toBe(label.id);
  await runGraph(page);
  await page.screenshot({ path: testInfo.outputPath("graph-summary.png") });
  const after = await geometry(page);
  expect.soft(after.overlaps).toEqual([]);
  expect.soft(after.nodes).toEqual(before.nodes);
  expect.soft(after.labelOverlaps).toEqual([]);
  for (const label of after.labels) {
    expect.soft(label.nearest, label.id).toBe(label.id);
    expect.soft(label.bannerOverlap, label.id).toBe(false);
  }
  const response = await page.request.get(`/api/v1/workspace/document?path=${graph.directory}/graph.layout.json`);
  expect((await response.json()).content.layout).toEqual(graph.layout);
});

for (const count of [1, 2]) {
  test(`${count} bypass calls avoid the middle node and keep their labels clear`, async ({ page, graph }, testInfo) => {
    const target = resolve("../apps/server/build/e2e-workspace", graph.directory);
    const model: ModelFile = JSON.parse(await readFile("../examples/retry-storm/retry-storm.model.json", "utf8"));
    const bypasses = Array.from({ length: count }, (_, index) => ({ id: `bypass-${index + 1}`, type: "call",
      from: "gateway", to: "dependency", params: { timeout: "80ms", attempts: 3 } }));
    model.connections.push(...bypasses);
    const layout: LayoutFile = { schemaVersion: 1, positions: {
      client: { x: 0, y: 100 }, gateway: { x: 340, y: 100 }, middle: { x: 680, y: 100 }, dependency: { x: 1020, y: 100 },
    } };
    await writeFile(resolve(target, "graph.model.json"), JSON.stringify(model));
    await writeFile(resolve(target, "graph.layout.json"), JSON.stringify(layout));
    await page.reload();
    await expect(page.getByTestId("block-node")).toHaveCount(4);
    await expect(page.getByTestId("canvas-edge-label-bypass-1")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`bypass-${count}.png`) });
    for (const { id } of bypasses) {
      const crossings = await page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).evaluate(pathElement => {
        const path = pathElement as SVGPathElement;
        const matrix = path.getScreenCTM()!;
        const nodes = [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
          .filter(node => !["gateway", "dependency"].includes(node.dataset.id!));
        const length = path.getTotalLength();
        return nodes.filter(node => {
          const rect = node.getBoundingClientRect();
          for (let index = 0; index <= Math.ceil(length); index++) {
            const point = path.getPointAtLength(length * index / Math.ceil(length)).matrixTransform(matrix);
            if (point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom) return true;
          }
          return false;
        }).map(node => node.dataset.id);
      });
      expect.soft(crossings, id).toEqual([]);
    }
    const measured = await geometry(page);
    expect.soft(measured.labelOverlaps).toEqual([]);
    for (const label of measured.labels) {
      expect.soft(label.nodeOverlaps, label.id).toEqual([]);
      expect.soft(label.nearest, label.id).toBe(label.id);
    }
    await page.getByTestId("canvas-edge-label-bypass-1").click();
    await expect(page.getByTestId("canvas-edge-label-bypass-1")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("rf__node-client").locator('[data-handleid="out"]').dragTo(
      page.getByTestId("rf__node-middle").locator('[data-handleid="in"]'));
    await expect(page.locator('.react-flow__edge[data-id="client-to-middle"]')).toBeAttached();
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    const response = await page.request.get(`/api/v1/workspace/document?path=${graph.directory}/graph.layout.json`);
    expect((await response.json()).content.layout).toEqual(layout);
  });
}

test("manual viewport survives results and Analysis keeps a usable canvas", async ({ page, graph }, testInfo) => {
  void graph;
  await runGraph(page);
  const zoomIn = page.getByRole("button", { name: "Приблизить", exact: true });
  const scale = () => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  const initial = await scale();
  await zoomIn.click();
  // Wait for the control's animated zoom to settle before testing a panel change.
  await expect.poll(scale).toBeCloseTo(Math.min(2, initial * 1.2), 4);
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(pane.x + 30, pane.y + pane.height / 2);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(pane.x + 80, pane.y + pane.height / 2 + 10, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  const translation = () => page.locator(".react-flow__viewport").evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f };
  });
  const panned = await translation();
  const manual = await scale();
  await page.getByRole("button", { name: "Свернуть результаты", exact: true }).click();
  await expect.soft.poll(scale).toBeCloseTo(manual, 4);
  expect.soft(await translation()).toEqual(panned);
  await page.getByRole("tab", { name: "Ответ", exact: true }).click();
  await expect.soft.poll(scale).toBeCloseTo(manual, 4);
  expect.soft(await translation()).toEqual(panned);
  await page.getByRole("button", { name: "Вместить схему", exact: true }).click();
  await page.getByRole("button", { name: "Анализ", exact: true }).click();
  await page.getByRole("button", { name: "Вместить схему", exact: true }).click();
  const canvas = page.getByRole("application", { name: "Полотно модели", exact: true });
  await expect.soft.poll(async () => (await canvas.boundingBox())!.height).toBeGreaterThanOrEqual(252);
  await expect.soft.poll(scale).toBeGreaterThanOrEqual(0.3);
  await page.screenshot({ path: testInfo.outputPath("graph-analysis.png") });
});

for (const activation of ["double-click", "enter", "add"] as const) {
  test(`palette ${activation} inserts the measured node inside the visible canvas`, async ({ page, graph }) => {
    void graph;
    // At a large scale, starting at the viewport centre and walking only down/right can leave the canvas.
    for (let index = 0; index < 7; index++) await page.getByRole("button", { name: "Приблизить", exact: true }).click();
    const palette = page.getByRole("complementary", { name: "Палитра", exact: true });
    const service = palette.getByRole("button", { name: "Сервис", exact: true });
    for (let index = 1; index <= 3; index++) {
      if (activation === "double-click") await service.dblclick();
      else if (activation === "enter") await service.press("Enter");
      else {
        await service.click();
        await page.getByRole("button", { name: "Добавить", exact: true }).click();
      }
      const node = page.getByTestId(`rf__node-service-${index}`);
      await expect(node).toBeInViewport({ ratio: 0.99 });
      const bounds = (await page.getByRole("application", { name: "Полотно модели", exact: true }).boundingBox())!;
      const rectangle = (await node.boundingBox())!;
      expect(rectangle.x).toBeGreaterThanOrEqual(bounds.x);
      expect(rectangle.y).toBeGreaterThanOrEqual(bounds.y);
      expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
  });
}

test("MiniMap wheel zoom survives opening results", async ({ page, graph }) => {
  void graph;
  const scale = () => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  await expect.poll(scale).toBeGreaterThan(0.4);
  const initial = await scale();
  await page.locator(".react-flow__minimap").hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(scale).toBeGreaterThan(initial);
  const manual = await scale();
  await page.getByRole("tab", { name: /^Проблемы/ }).click();
  await page.getByRole("separator", { name: "Изменить высоту панели результатов", exact: true }).press("End");
  await expect.poll(scale).toBeCloseTo(manual, 4);
});

test("first block respects the manually positioned empty canvas", async ({ page, graph }) => {
  const path = resolve("../apps/server/build/e2e-workspace", graph.directory, "graph.model.json");
  const model: ModelFile = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...model, blocks: {}, connections: [] }));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(0);
  await page.getByRole("button", { name: "Отдалить", exact: true }).click();
  const viewport = () => page.locator(".react-flow__viewport").getAttribute("style");
  const manual = await viewport();
  await page.getByRole("complementary", { name: "Палитра", exact: true }).getByRole("button", { name: "Сервис", exact: true }).press("Enter");
  await expect(page.getByTestId("rf__node-service-1")).toHaveClass(/selected/);
  await expect.poll(viewport).toBe(manual);
});

test("labels stay on long diagonal and backward edges", async ({ page, graph }) => {
  const layout = structuredClone(graph.layout);
  layout.positions.database = { x: 1340, y: 1000 };
  layout.positions["replica-b"] = { x: 1800, y: 200 };
  await writeFile(resolve("../apps/server/build/e2e-workspace", graph.directory, "graph.layout.json"), JSON.stringify(layout));
  await page.reload();
  await runGraph(page);
  for (const label of (await geometry(page)).labels) expect(label.nearest, label.id).toBe(label.id);
});

test("compact branch labels remain nearest their own edges", async ({ page, graph }) => {
  const layout = structuredClone(graph.layout);
  Object.values(layout.positions).forEach(position => { position.x = Math.round(position.x / 350) * 260; });
  await writeFile(resolve("../apps/server/build/e2e-workspace", graph.directory, "graph.layout.json"), JSON.stringify(layout));
  await page.reload();
  await runGraph(page);
  const measured = await geometry(page);
  expect(measured.overlaps).toEqual([]);
  expect(measured.labelOverlaps).toEqual([]);
  for (const label of measured.labels) expect(label.nearest, label.id).toBe(label.id);
});
