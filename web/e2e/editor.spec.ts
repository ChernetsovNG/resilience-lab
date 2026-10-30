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

test("opens saves and runs a load profile without losing points or sinusoid fields", async ({ page, files }) => {
  const profiled = (await stored(page, files.model)).content.model as ModelFile;
  const load = { points: [{ time: "0s", rate: "120/s" }, { time: "1s", rate: "180/s" }],
    sinusoid: { amplitude: "20/s", period: "1s", phase: -0.5 } };
  profiled.blocks.client.params.load = load;
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(profiled));
  await page.reload();
  await page.getByTestId("rf__node-client").locator(".block-node > strong").click();
  const points = page.getByRole("textbox", { name: "Load points" });
  await expect(points).toHaveAttribute("readonly", "");
  expect(JSON.parse(await points.inputValue())).toEqual(load.points);
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await page.getByLabel("Handlers", { exact: true }).fill("5");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await save(page);
  profiled.blocks.gateway.params.handlers = 5;
  expect((await stored(page, files.model)).content.model).toEqual(profiled);
  await page.reload();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  expect((await stored(page, files.model)).content.model).toEqual(profiled);
});

test("opens edits saves and runs a database without losing query parameters", async ({ page, files }) => {
  const source = (await stored(page, files.model)).content.model as ModelFile;
  source.blocks.dependency.type = "database";
  source.blocks.dependency.params = {
    maxConnections: 2, queue: 8, processing: { kind: "lognormal", mean: "7ms", stdDev: "2ms" }, failureRate: "1%",
  };
  const experiment = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  experiment.faults = [];
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(source));
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.experiment), JSON.stringify(experiment));
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Database", exact: true })).toBeVisible();
  await page.getByTestId("rf__node-dependency").locator(".block-node > strong").click();
  await expect(page.getByRole("group", { name: "Query time", exact: true }).getByLabel("Mean", { exact: true })).toHaveValue("7ms");
  await page.getByLabel("Maximum connections", { exact: true }).fill("3");
  await page.getByLabel("Maximum connections", { exact: true }).press("Enter");
  await save(page);
  source.blocks.dependency.params.maxConnections = 3;
  expect((await stored(page, files.model)).content.model).toEqual(source);
  await page.reload();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  expect((await stored(page, files.model)).content.model).toEqual(source);
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await page.getByTestId("rf__node-dependency").locator(".block-node > strong").click();
  await expect(page.locator(".element-results")).toContainText("Connections busy");
  await expect(page.locator(".element-results")).toContainText("Mean query queue");
  await expect(page.locator(".element-results")).toContainText("max_connections rejection share");
});

test("opens saves and runs replica groups without losing per-replica parameters", async ({ page, files }) => {
  const grouped = (await stored(page, files.model)).content.model as ModelFile;
  grouped.blocks.middle.params.replicas = 3;
  grouped.blocks.middle.replicaOverrides = { "2": { handlers: 7, processing: { mean: "9ms" } } };
  grouped.connections.find(edge => edge.id === "gateway-to-middle")!.params.balancing = "leastInFlight";
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(grouped));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await page.getByLabel("Handlers", { exact: true }).fill("5");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await save(page);
  grouped.blocks.gateway.params.handlers = 5;
  expect((await stored(page, files.model)).content.model).toEqual(grouped);
  await page.reload();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  expect((await stored(page, files.model)).content.model).toEqual(grouped);
});

test("opens saves and runs a router with three weighted outputs without losing routing parameters", async ({ page, files }) => {
  const routed = (await stored(page, files.model)).content.model as ModelFile;
  expect(routed.schemaVersion).toBe(4);
  routed.blocks.router = { type: "router", params: { policy: "random" }, description: null, notes: null, scenario: null, replicaOverrides: null };
  routed.blocks.gateway.scenario = [
    { type: "process", processing: { kind: "fixed", mean: "2ms" }, failureRate: "0%", connection: null },
    { type: "call", connection: "gateway-to-middle", processing: null, failureRate: null },
    { type: "process", processing: null, failureRate: null, connection: null },
    { type: "call", connection: "gateway-to-middle", processing: null, failureRate: null },
  ];
  routed.blocks.third = structuredClone(routed.blocks.dependency);
  const call = routed.connections.find(edge => edge.id === "gateway-to-middle")!;
  call.to = "router";
  call.params.retryTarget = "other";
  routed.connections.push(...["middle", "dependency", "third"].map((to, index) => ({
    id: `route-${to}`, type: "route", from: "router", to, params: { weight: index + 1 }, description: null, notes: null,
  })));
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(routed));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(6);
  await expect(page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Router", exact: true })).toBeVisible();
  await page.getByTestId("rf__node-router").locator(".block-node > strong").click();
  await page.getByLabel("Policy", { exact: true }).selectOption("leastInFlight");
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await page.getByLabel("Handlers", { exact: true }).fill("5");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await save(page);
  const expected = structuredClone(routed);
  expected.blocks.router.params.policy = "leastInFlight";
  expected.blocks.gateway.params.handlers = 5;
  expect((await stored(page, files.model)).content.model).toEqual(expected);
  await page.reload();
  await expect(page.getByTestId("rf__node-router")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  expect((await stored(page, files.model)).content.model).toEqual(expected);
});

test("edits and clears the shared series window with validation, persistence and undo", async ({ page, files }) => {
  const windowField = page.getByLabel("Series window", { exact: true });
  await expect(windowField).toHaveValue("");
  await expect(windowField).toHaveAttribute("placeholder", "10ms");
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await page.getByRole("button", { name: "Experiment", exact: true }).click();
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
  const box = await locator.locator(".block-node > strong").boundingBox();
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

test("adds a block with Tab and Enter at the panned viewport center, with undo and persistence", async ({ page, files }) => {
  await page.addInitScript(() => {
    const target = window as Window & { paletteErrors: string[] };
    target.paletteErrors = [];
    target.addEventListener("error", (error) => target.paletteErrors.push(error.message));
  });
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  const run = page.getByRole("button", { name: "Run", exact: true });
  await expect(run).toBeEnabled();
  await expect(page.locator(".diagnostic-badge--variants")).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  const palette = page.getByRole("complementary", { name: "Palette" });
  const service = palette.getByRole("button", { name: "Service", exact: true });
  const canvas = page.getByLabel("Model canvas", { exact: true });
  await expect(palette).toHaveCSS("width", "48px");
  await expect(palette.getByText("Connections", { exact: true })).toHaveCount(0);
  await service.hover();
  await expect(palette.getByRole("tooltip").filter({ hasText: "Blocking service" })).toBeVisible();
  await page.locator(".react-flow__controls-zoomout").click();
  const bounds = (await canvas.boundingBox())!;
  // Move the existing chain above the visible center, leaving a free insertion point after zooming.
  await page.mouse.move(bounds.x + 80, bounds.y + bounds.height - 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 70, bounds.y + bounds.height - 280, { steps: 12 });
  await page.mouse.up();
  // Let the pan finish rendering before sending native keyboard activation.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const expected = await canvas.evaluate((element) => {
    const viewport = element.querySelector(".react-flow__viewport")!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const box = element.getBoundingClientRect();
    return { x: Math.round((box.width / 2 - matrix.e) / matrix.a / 20) * 20,
      y: Math.round((box.height / 2 - matrix.f) / matrix.d / 20) * 20 };
  });
  await run.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "View", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(palette.getByRole("button", { name: "Client", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(service).toBeFocused();
  await expect(palette.getByRole("tooltip").filter({ hasText: "Blocking service" })).toBeVisible();
  await page.keyboard.press("Enter");
  const node = page.getByTestId("rf__node-service-1");
  await expect(node).toHaveClass(/selected/);
  await expect(node).toHaveCSS("transform", `matrix(1, 0, 0, 1, ${expected.x}, ${expected.y})`);
  await expect(page.getByRole("heading", { name: "service-1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(node).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(node).not.toHaveClass(/selected/);
  await expect(page.getByRole("heading", { name: "Run settings", exact: true })).toBeVisible();
  await node.click();
  await page.getByLabel("Handlers", { exact: true }).fill("2");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await page.getByLabel("Distribution", { exact: true }).selectOption("fixed");
  await page.getByLabel("Mean", { exact: true }).fill("2ms");
  await page.getByLabel("Mean", { exact: true }).press("Enter");
  await save(page);
  expect((await stored(page, files.layout)).content.layout.positions["service-1"]).toEqual(expected);
  await page.reload();
  await expect(node).toBeVisible();
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await expect(service).toBeDisabled();
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await service.click();
  const second = page.getByTestId("rf__node-service-2");
  await expect(second).toHaveClass(/selected/);
  const boxes = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((element) => {
    const box = element.getBoundingClientRect();
    return { id: element.getAttribute("data-id"), x: box.x, y: box.y, right: box.right, bottom: box.bottom };
  }));
  const added = boxes.find((box) => box.id === "service-2")!;
  for (const box of boxes.filter((box) => box.id !== "service-2")) {
    expect(added.x < box.right && added.right > box.x && added.y < box.bottom && added.bottom > box.y).toBe(false);
  }
  // ResizeObserver reports loop errors after delivery; let both rendering frames complete.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as Window & { paletteErrors: string[] }).paletteErrors)).toEqual([]);
});

test("measures a new Client before collision checks when required-field hints make it wider", async ({ page, files }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const source = (await stored(page, files.model)).content.model as ModelFile;
  const sourceLayout = (await stored(page, files.layout)).content.layout as LayoutFile;
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model),
    JSON.stringify({ ...source, blocks: { client: source.blocks.client }, connections: [] }));
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.layout),
    JSON.stringify({ ...sourceLayout, positions: { client: { x: 0, y: 200 } } }));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(1);
  // Removing the services invalidates the experiment; wait for Problems to resize the canvas before panning.
  await expect(page.getByRole("tab", { name: /^Problems/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const canvas = page.getByLabel("Model canvas", { exact: true });
  const bounds = (await canvas.boundingBox())!;
  const delta = await canvas.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element.querySelector(".react-flow__viewport")!).transform);
    const box = element.getBoundingClientRect();
    return { x: box.width / 2 + 180 * matrix.a - matrix.e, y: box.height / 2 - 200 * matrix.d - matrix.f };
  });
  await page.mouse.move(bounds.x + 20, bounds.y + bounds.height - 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 20 + delta.x, bounds.y + bounds.height - 40 + delta.y, { steps: 12 });
  await page.mouse.up();
  await page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Client", exact: true }).click();
  const incoming = page.getByTestId("rf__node-client-1");
  await expect(incoming).toHaveClass(/selected/);
  await expect(incoming).toHaveCSS("transform", "matrix(1, 0, 0, 1, -100, 280)");
  const oldBox = (await page.getByTestId("rf__node-client").boundingBox())!;
  const newBox = (await incoming.boundingBox())!;
  expect(newBox.width).toBeGreaterThan(oldBox.width);
  expect(newBox.x < oldBox.x + oldBox.width && newBox.x + newBox.width > oldBox.x &&
    newBox.y < oldBox.y + oldBox.height && newBox.y + newBox.height > oldBox.y).toBe(false);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(incoming).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("extends the chain through real drag and ports, persists positions and commits a move as one layout-only command", async ({ page, files }) => {
  const canvas = page.getByLabel("Model canvas", { exact: true });
  const bounds = await canvas.boundingBox();
  await page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service", exact: true })
    .dragTo(canvas, { targetPosition: { x: bounds!.width * 0.55, y: bounds!.height * 0.7 } });
  const node = page.getByTestId("rf__node-service-1");
  await expect(node).toBeVisible();
  await expect(node).toHaveClass(/selected/);
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


test("keeps the Inspector on one target and manages variant pages through their menus", async ({ page, files }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const gateway = page.getByTestId("rf__node-gateway");
  await gateway.click();
  await expect(inspector.getByLabel("Handlers", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Run settings" })).toHaveCount(0);
  await expect(inspector.getByLabel("Variant ID", { exact: true })).toHaveCount(0);
  await expect(inspector.locator(".param-description").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("after-element.png") });

  await page.locator(".react-flow__pane").click({ position: { x: 15, y: 15 } });
  await expect(inspector.getByRole("heading", { name: "Run settings" })).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Parameter grid" })).toBeVisible();
  await gateway.click();
  await page.getByRole("button", { name: "Experiment", exact: true }).click();
  await expect(inspector.getByLabel("Replications", { exact: true })).toBeVisible();
  await expect(inspector.getByLabel("Handlers", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("after-experiment.png") });

  const source = page.getByRole("tab", { name: "No retries", exact: true });
  await source.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("after-variant-menu.png") });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  const copy = page.getByRole("tab", { name: "No retries copy", exact: true });
  await expect(copy).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByLabel("Variant ID", { exact: true })).toHaveValue("variant-1");
  await expect(inspector.getByRole("heading", { name: "Run settings" })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(copy).toHaveCount(0);
  await expect(inspector.getByRole("heading", { name: "Run settings" })).toBeVisible();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(copy).toBeVisible();

  await copy.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Duplicate", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(inspector.getByLabel("Variant label", { exact: true })).toBeFocused();
  await expect(copy).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: testInfo.outputPath("after-variant.png") });
  await copy.focus();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("End");
  page.once("dialog", dialog => dialog.accept());
  await page.keyboard.press("Enter");
  await expect(copy).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(copy).toBeVisible();
  await page.getByRole("button", { name: "Add variant", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Variant 2", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(inspector.getByRole("heading", { name: "Run settings" })).toBeVisible();
  const original = JSON.parse(await readFile(resolve("../apps/server/build/e2e-workspace", files.experiment), "utf8"));
  expect(original.variants).toHaveLength(2);
});
