import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExperimentFile, LayoutFile, ModelFile } from "../src/api/apiTypes";

type Files = { model: string; layout: string; experiment: string };
const test = base.extend<{ files: Files }>({
  files: async ({ page }, provide) => {
    const directory = `canvas-editor-${randomUUID()}`;
    const target = resolve("../apps/server/build/e2e-workspace", directory);
    await cp(resolve("../examples/retry-storm"), target, { recursive: true, errorOnExist: true, force: false });
    const files = {
      model: `${directory}/retry-storm.model.json`, layout: `${directory}/retry-storm.layout.json`,
      experiment: `${directory}/retry-storm.experiment.json`,
    };
    try {
      await page.goto("/");
      await page.getByLabel("Experiment").selectOption(files.experiment);
      await expect(page.getByTestId("block-node")).toHaveCount(4);
      await provide(files);
    } finally {
      await rm(target, { recursive: true });
    }
  },
});
test.use({ actionTimeout: 10_000 });

test("edits and clears the shared series window with validation, persistence and undo", async ({ page, files }) => {
  const windowField = page.getByLabel("Series window", { exact: true });
  await expect(windowField).toHaveValue("");
  await expect(windowField).toHaveAttribute("placeholder", "10ms");
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await page.getByLabel("Measurement", { exact: true }).fill("2s");
  await page.getByLabel("Measurement", { exact: true }).press("Enter");
  await expect(windowField).toHaveAttribute("placeholder", "20ms");

  const validation = page.waitForResponse((response) => response.url().endsWith("/api/v1/validate") &&
    response.request().postDataJSON().drafts.some((draft: { content: { experiment?: ExperimentFile } }) =>
      draft.content.experiment?.execution.window === "0ms"));
  await windowField.fill("0ms");
  await windowField.press("Enter");
  const result = await (await validation).json();
  const diagnostic = result.diagnostics.find((item: { pointer: string }) => item.pointer === "/execution/window");
  expect(diagnostic).toBeTruthy();
  await expect(windowField.locator("..")).toContainText(diagnostic.message);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  await windowField.fill("0.25s");
  await windowField.press("Enter");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(windowField).toHaveValue("0ms");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(windowField).toHaveValue("0.25s");
  await expect(windowField).not.toHaveAttribute("aria-invalid", "true");
  await save(page);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  expect((await stored(page, files.experiment)).content.experiment.execution.window).toBe("0.25s");
  await page.reload();
  await expect(windowField).toHaveValue("0.25s");

  await windowField.fill("");
  await windowField.press("Enter");
  await expect(windowField).toHaveAttribute("placeholder", "20ms");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(windowField).toHaveValue("0.25s");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(windowField).toHaveValue("");
  await save(page);
  const saved = JSON.parse(await readFile(resolve("../apps/server/build/e2e-workspace", files.experiment), "utf8"));
  expect(saved.execution).not.toHaveProperty("window");
  await page.reload();
  await expect(windowField).toHaveValue("");
  await expect(windowField).toHaveAttribute("placeholder", "20ms");
});

test("edits timeout on the canvas with undo and a persisted variant override", async ({ page, files }) => {
  const originalModel = (await stored(page, files.model)).content.model as ModelFile;
  const timeout = page.getByTestId("canvas-param-gateway-to-middle-timeout");
  const input = timeout.getByRole("textbox", { name: "Timeout", exact: true });
  await expect(timeout).toHaveText("80ms");

  await timeout.dblclick();
  await input.fill("90ms");
  await input.press("Enter");
  await expect(timeout).toHaveText("90ms");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(timeout).toHaveText("80ms");

  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await timeout.dblclick();
  await input.fill("100ms");
  await input.press("Enter");
  await expect(timeout).toHaveText("100ms");
  await save(page);

  const experiment = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  expect(experiment.variants.find((variant) => variant.id === "no-retries")!.overrides["gateway-to-middle.timeout"]).toBe("100ms");
  expect((await stored(page, files.model)).content.model).toEqual(originalModel);

  await page.reload();
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await expect(timeout).toHaveText("100ms");
});

test("keeps every canvas value clickable and opens gateway mean with an error-colored message", async ({ page, files }) => {
  const originalLayout = (await stored(page, files.layout)).content.layout as LayoutFile;
  expect(originalLayout.positions).toEqual({
    client: { x: 0, y: 100 }, gateway: { x: 260, y: 100 }, middle: { x: 520, y: 100 }, dependency: { x: 780, y: 100 },
  });
  const values = [
    ...["gateway", "middle", "dependency"].flatMap((id) => ["handlers", "queue", "processing.mean"].map((path) => `canvas-param-${id}-${path}`)),
    ...["gateway-to-middle", "middle-to-dependency"].flatMap((id) => ["timeout", "attempts"].map((path) => `canvas-param-${id}-${path}`)),
  ];
  for (const testId of values) {
    const value = page.getByTestId(testId);
    await expect(value).toBeVisible();
    const hit = await value.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        ?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
    });
    expect(hit, `${testId} must receive pointer events at its center`).toBe(testId);
  }

  const mean = page.getByTestId("canvas-param-gateway-processing.mean");
  await mean.dblclick();
  const input = mean.getByRole("textbox", { name: "Mean", exact: true });
  await expect(input).toBeVisible();
  await input.fill("invalid");
  await expect(mean.locator(".inline-param-error")).toHaveCSS("color", "rgb(220, 38, 38)");
});

test("shows and reloads an external model edit within five seconds", async ({ page, files }) => {
  await writeHandlers(files, 9);
  const alert = page.getByRole("alert").filter({ hasText: files.model });
  await expect(alert).toContainText("The document changed on disk", { timeout: 5000 });

  await alert.getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByTestId("rf__node-gateway").click();
  await expect(page.getByLabel("Handlers", { exact: true })).toHaveValue("9");
});

test("keeps a draft when external model reload is dismissed and reloads after confirmation", async ({ page, files }) => {
  await page.getByTestId("rf__node-gateway").click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  await handlers.fill("6");
  await handlers.press("Enter");
  await writeHandlers(files, 9);
  const alert = page.getByRole("alert").filter({ hasText: files.model });
  await expect(alert).toContainText("Reload will discard unsaved changes", { timeout: 5000 });

  page.once("dialog", (dialog) => dialog.dismiss());
  await alert.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(handlers).toHaveValue("6");
  await expect(alert).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await alert.getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByTestId("rf__node-gateway").click();
  await expect(handlers).toHaveValue("9");
});

test("does not show an external-change banner for an own save journal entry", async ({ page, files }) => {
  await page.getByTestId("rf__node-gateway").click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  await handlers.fill("6");
  await handlers.press("Enter");
  const ownEntry = page.waitForResponse(async (response) => {
    if (!response.url().includes("/api/v1/workspace/changes?")) return false;
    const body = await response.json();
    return body.changes.some((change: { path: string }) => change.path === files.model);
  });

  await save(page);
  await ownEntry;

  await expect(page.getByRole("alert").filter({ hasText: "The document changed on disk" })).toHaveCount(0);
});

async function writeHandlers(files: Files, value: number) {
  const path = resolve("../apps/server/build/e2e-workspace", files.model);
  const source: ModelFile = JSON.parse(await readFile(path, "utf8"));
  source.blocks.gateway.params.handlers = value;
  await writeFile(path, JSON.stringify(source));
}

async function stored(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
}
async function move(page: Page, locator: Locator, dx: number, dy: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}
async function connect(page: Page, from: string, to: string, targetPort = "in") {
  const source = page.getByTestId(`rf__node-${from}`).locator('[data-handleid="out"]');
  const target = page.getByTestId(`rf__node-${to}`).locator(`[data-handleid="${targetPort}"]`);
  await source.dragTo(target);
}

test("extends the chain through real drag and ports, persists positions and commits a move as one layout-only command", async ({ page, files }) => {
  const canvas = page.getByLabel("Model canvas", { exact: true });
  const bounds = await canvas.boundingBox();
  await page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service", exact: true })
    .dragTo(canvas, { targetPosition: { x: bounds!.width * 0.55, y: bounds!.height * 0.7 } });
  const node = page.getByTestId("rf__node-service-1");
  await expect(node).toBeVisible();
  await node.click();
  await page.getByLabel("Handlers", { exact: true }).fill("2");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await expect(page.getByLabel("Distribution", { exact: true })).toHaveValue("");
  await page.getByLabel("Distribution", { exact: true }).selectOption("fixed");
  await page.getByLabel("Mean", { exact: true }).fill("2ms");
  await page.getByLabel("Mean", { exact: true }).press("Enter");
  await page.locator(".react-flow__controls-fitview").click();
  await connect(page, "dependency", "client", "out");
  await expect(page.getByRole("alert")).toContainText("Connect an output port");
  await connect(page, "dependency", "service-1");
  const edge = page.getByTestId("rf__edge-dependency-to-service-1");
  await expect(edge).toBeAttached();
  await page.getByTestId("canvas-edge-label-dependency-to-service-1").click();
  await page.getByLabel("Timeout", { exact: true }).fill("80ms");
  await page.getByLabel("Timeout", { exact: true }).press("Enter");
  await save(page);
  const initial = await stored(page, files.model);
  const layout = (await stored(page, files.layout)).content.layout as LayoutFile;
  expect(initial.content.model.blocks["service-1"].params).toEqual({ handlers: 2, processing: { kind: "fixed", mean: "2ms" } });
  expect(initial.content.model.connections.at(-1)).toMatchObject({ id: "dependency-to-service-1", from: "dependency", to: "service-1", type: "call", params: { timeout: "80ms" } });
  expect(layout.positions["service-1"].x % 20).toBe(0);
  expect(layout.positions["service-1"].y % 20).toBe(0);
  await page.reload();
  await expect(node).toBeVisible();
  await expect(edge).toBeAttached();
  await move(page, node, -60, -60);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await save(page);
  const moved = (await stored(page, files.layout)).content.layout as LayoutFile;
  expect(moved.positions["service-1"]).not.toEqual(layout.positions["service-1"]);
  expect({ ...moved, positions: { ...moved.positions, "service-1": layout.positions["service-1"] } }).toEqual(layout);
  expect((await stored(page, files.model)).version).toBe(initial.version);
  await page.reload();
  await expect(node).toHaveCSS("transform", `matrix(1, 0, 0, 1, ${moved.positions["service-1"].x}, ${moved.positions["service-1"].y})`);
});

test("renames and deletes with experiment cascades, undo restores the complete saved documents", async ({ page, files }) => {
  await page.getByTestId("rf__node-dependency").click();
  await page.getByLabel("Identifier", { exact: true }).fill("storage");
  await page.getByLabel("Identifier", { exact: true }).press("Enter");
  await expect(page.getByTestId("rf__node-storage")).toBeVisible();
  await save(page);
  const renamedModel = (await stored(page, files.model)).content.model as ModelFile;
  const renamedExperiment = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  const renamedLayout = (await stored(page, files.layout)).content.layout as LayoutFile;
  expect(renamedModel.connections.find((edge) => edge.id === "middle-to-dependency")!.to).toBe("storage");
  expect(renamedExperiment.faults[0].target).toBe("storage");
  expect(renamedLayout.positions.storage).toEqual({ x: 780, y: 100 });
  expect(renamedLayout.positions.dependency).toBeUndefined();
  await page.getByTestId("rf__node-middle").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("rf__node-middle")).toHaveCount(0);
  await expect(page.getByTestId("rf__edge-gateway-to-middle")).toHaveCount(0);
  await expect(page.getByTestId("rf__edge-middle-to-dependency")).toHaveCount(0);
  await save(page);
  const deletedExperiment = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  expect(deletedExperiment.variants.find((variant) => variant.id === "no-retries")!.overrides).toEqual({});
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("rf__node-middle")).toBeVisible();
  await expect(page.getByTestId("rf__edge-middle-to-dependency")).toBeAttached();
  await save(page);
  expect((await stored(page, files.model)).content.model).toEqual(renamedModel);
  expect((await stored(page, files.experiment)).content.experiment).toEqual(renamedExperiment);
  expect((await stored(page, files.layout)).content.layout).toEqual(renamedLayout);
  await page.reload();
  await expect(page.getByTestId("rf__node-storage")).toBeVisible();
});

test("moves a multi-selection once, copies its internal connection, and keeps variant structure read-only", async ({ page, files }) => {
  const uninitialized: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("not initialized")) uninitialized.push(message.text());
  });
  const before = (await stored(page, files.layout)).content.layout as LayoutFile;
  const gateway = page.getByTestId("rf__node-gateway");
  await gateway.click();
  await page.getByTestId("rf__node-middle").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await move(page, gateway, 0, 60);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(gateway).not.toHaveCSS("transform", `matrix(1, 0, 0, 1, ${before.positions.gateway.x}, ${before.positions.gateway.y})`);
  await expect(page.getByTestId("rf__node-middle")).not.toHaveCSS("transform", `matrix(1, 0, 0, 1, ${before.positions.middle.x}, ${before.positions.middle.y})`);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByTestId("block-node")).toHaveCount(6);
  await expect(page.getByTestId("rf__node-service-1")).toHaveClass(/selected/);
  await expect(gateway).not.toHaveClass(/selected/);
  await expect(page.getByTestId("rf__edge-service-1-to-service-2")).toBeAttached();
  await save(page);
  const copy = (await stored(page, files.layout)).content.layout as LayoutFile;
  expect(copy.positions["service-1"]).toEqual({ x: before.positions.gateway.x + 40, y: before.positions.gateway.y + 40 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service" })).toBeDisabled();
  await gateway.click();
  await expect(page.getByLabel("Identifier", { exact: true })).not.toBeEditable();
  await page.keyboard.press("Delete");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await expect(gateway).not.toHaveClass(/draggable/);
  expect(uninitialized).toEqual([]);
});
