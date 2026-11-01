import { randomUUID } from "node:crypto";
import { cp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, selectExperiment, test, type Locator, type Page } from "./fixtures";
import type { LayoutFile } from "../src/api/apiTypes";

// Real gestures and real storage: component tests cover the individual geometry rules.
test.use({ locale: "ru-RU", viewport: { width: 1600, height: 1000 } });

async function stored(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).content;
}

async function save(page: Page) {
  const button = page.getByRole("button", { name: "Сохранить", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeDisabled();
}

async function drag(page: Page, control: Locator, dx: number, dy: number) {
  const rectangle = (await control.boundingBox())!;
  const x = rectangle.x + rectangle.width / 2, y = rectangle.y + rectangle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("manual node size and edge bends persist independently of model and experiment", async ({ page }, testInfo) => {
  const directory = `manual-layout-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  await cp(resolve("../examples/retry-storm"), target, { recursive: true });
  const path = (kind: string) => `${directory}/retry-storm.${kind}.json`;
  const diskPath = (kind: string) => resolve(target, `retry-storm.${kind}.json`);
  const sourceModel = await readFile(diskPath("model"), "utf8");
  const sourceExperiment = await readFile(diskPath("experiment"), "utf8");
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
  try {
    await page.goto("/");
    await selectExperiment(page, path("experiment"));
    await page.getByRole("tab", { name: "Модель", exact: true }).click();
    const initial: LayoutFile = (await stored(page, path("layout"))).layout;
    const model = await stored(page, path("model"));
    const experiment = await stored(page, path("experiment"));
    const node = page.getByTestId("rf__node-gateway");
    await expect(node).toBeVisible();
    const scale = () => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
    const canvas = (await page.locator(".react-flow").boundingBox())!;
    const startScale = await scale();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + 32);
    await page.mouse.wheel(0, Math.log2(startScale / 0.65) / 0.002);
    await expect.poll(scale).toBeCloseTo(0.65, 4);
    await node.locator(".block-node-header").click();
    const original = await node.evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight }));
    await drag(page, node.locator(".react-flow__resize-control.handle.top.left"), -52, -39);
    await save(page);
    const resized: LayoutFile = (await stored(page, path("layout"))).layout;
    expect(resized.positions.gateway.x).toBeCloseTo(initial.positions.gateway.x - 80, 0);
    expect(resized.positions.gateway.y).toBeCloseTo(initial.positions.gateway.y - 60, 0);
    expect(resized.sizes.gateway.width).toBeCloseTo(original.width + 80, 0);
    expect(resized.sizes.gateway.height).toBeCloseTo(original.height + 60, 0);
    expect({ ...resized, positions: initial.positions, sizes: {} }).toEqual(initial);
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await save(page);
    expect((await stored(page, path("layout"))).layout).toEqual(initial);
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await save(page);
    expect((await stored(page, path("layout"))).layout).toEqual(resized);

    const edge = page.getByTestId("rf__edge-gateway-to-middle");
    await edge.press("Enter");
    await expect(edge).toHaveClass(/selected/);
    const horizontal = page.locator('[data-edge-control="segment"][style*="ns-resize"]').first();
    await drag(page, horizontal, 0, -52);
    await save(page);
    const routed: LayoutFile = (await stored(page, path("layout"))).layout;
    expect(routed.edges["gateway-to-middle"].points.length).toBeGreaterThan(0);
    expect({ ...routed, edges: {} }).toEqual(resized);
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await save(page);
    expect((await stored(page, path("layout"))).layout).toEqual(resized);
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await save(page);
    expect((await stored(page, path("layout"))).layout).toEqual(routed);
    await drag(page, page.locator('[data-edge-control="bend"]').first(), 26, -26);
    await save(page);
    const bent: LayoutFile = (await stored(page, path("layout"))).layout;
    expect(bent.edges).not.toEqual(routed.edges);
    expect({ ...bent, edges: routed.edges }).toEqual(routed);
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await save(page);
    expect((await stored(page, path("layout"))).layout).toEqual(routed);
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await save(page);
    expect((await stored(page, path("layout"))).layout).toEqual(bent);
    await page.screenshot({ path: testInfo.outputPath("manual-edge-ru.png") });

    await page.reload();
    await expect(node).toBeVisible();
    expect((await stored(page, path("layout"))).layout).toEqual(bent);
    await expect.poll(() => node.evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight })))
      .toEqual({ width: Math.round(bent.sizes.gateway.width), height: Math.round(bent.sizes.gateway.height) });
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await node.locator(".block-node-header").click();
    await expect(page.locator(".react-flow__resize-control")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Сбросить размер", exact: true })).toHaveCount(0);
    await edge.press("Enter");
    await expect(page.locator("[data-edge-control]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Восстановить автоматический путь", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("manual-variant-readonly-ru.png") });

    await page.getByRole("tab", { name: "Модель", exact: true }).click();
    await edge.press("Enter");
    await page.getByRole("button", { name: "Восстановить автоматический путь", exact: true }).click();
    await node.locator(".block-node-header").click();
    await page.screenshot({ path: testInfo.outputPath("manual-node-size-ru.png") });
    await page.getByRole("button", { name: "Сбросить размер", exact: true }).click();
    await save(page);
    const reset: LayoutFile = (await stored(page, path("layout"))).layout;
    expect(reset).toEqual({ ...initial, positions: bent.positions });
    const canonical = JSON.parse(await readFile(diskPath("layout"), "utf8"));
    expect(canonical).toEqual({ schemaVersion: 2, positions: bent.positions });
    await page.reload();
    await expect(node).toBeVisible();
    expect((await stored(page, path("layout"))).layout).toEqual(reset);
    expect(await stored(page, path("model"))).toEqual(model);
    expect(await stored(page, path("experiment"))).toEqual(experiment);
    expect(await readFile(diskPath("model"), "utf8")).toBe(sourceModel);
    expect(await readFile(diskPath("experiment"), "utf8")).toBe(sourceExperiment);
  } finally { await rm(target, { recursive: true }); }
});
