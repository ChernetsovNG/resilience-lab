import { cleanupWorkspace, copyRetryStorm, selectExperiment } from "./fixtures";
import { dragCanvas, dragConnection, dragNode, dragPaletteBlock } from "./canvasGestures";
import { expect, test as base, type Page } from "./fixtures";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExperimentFile, LayoutFile, ModelFile, RunSummary } from "../src/api/apiTypes";

type Files = { model: string; layout: string; experiment: string };
const test = base.extend<{ files: Files }>({
  files: async ({ page }, provide) => {
    const directory = `canvas-editor-${randomUUID()}`;
    const target = resolve("../apps/server/build/e2e-workspace", directory);
    await copyRetryStorm(target);
    const files = {
      model: `${directory}/retry-storm.model.json`, layout: `${directory}/retry-storm.layout.json`,
      experiment: `${directory}/retry-storm.experiment.json`,
    };
    try {
      await page.goto("/");
      await selectExperiment(page, files.experiment);
      await expect(page.getByTestId("block-node")).toHaveCount(4);
      await provide(files);
    } finally {
      await cleanupWorkspace(page, target);
    }
  },
});
test.use({ actionTimeout: 10_000 });

test("opens saves and runs a transaction pooler and displays both resource limits", async ({ page, files }) => {
  const source = (await stored(page, files.model)).content.model as ModelFile;
  source.blocks.pooler = { type: "pooler", params: {
    maxClientConnections: 4, poolSize: 2, waitTimeout: "20ms", processing: { kind: "fixed", mean: "0.25ms" },
  }, description: null, notes: null, scenario: null, replicaOverrides: null, title: null };
  source.connections.find(edge => edge.id === "middle-to-dependency")!.to = "pooler";
  source.connections.push({ id: "pooler-to-dependency", type: "call", from: "pooler", to: "dependency",
    params: { timeout: "60ms" }, description: null, notes: null, classes: null });
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(source));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(5);
  await expect(page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Transaction pooler", exact: true })).toBeVisible();
  await page.getByTestId("rf__node-pooler").locator(".block-node > strong").click();
  await expect(page.getByLabel("Maximum client connections", { exact: true })).toHaveValue("4");
  await expect(page.getByLabel("Server connection wait timeout", { exact: true })).toHaveValue("20ms");
  await page.getByLabel("Server pool size", { exact: true }).fill("3");
  await page.getByLabel("Server pool size", { exact: true }).press("Enter");
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await page.getByLabel("Handlers", { exact: true }).fill("5");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await save(page);
  source.blocks.pooler.params.poolSize = 3;
  source.blocks.gateway.params.handlers = 5;
  expect((await stored(page, files.model)).content.model).toEqual(source);
  await page.reload();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const summary: RunSummary = await (await response).json();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  expect(summary.variants[0].points[0].aggregate.poolers.pooler.totals.offeredAttempts).toBeGreaterThan(0);
  expect(summary.variants[0].points[0].aggregate.services.pooler).toBeUndefined();
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await page.getByTestId("rf__node-pooler").locator(".block-node > strong").click();
  await expect(page.locator(".element-results")).toContainText("Server pool utilization");
  await expect(page.locator(".element-results")).toContainText("Waiting clients");
  await expect(page.locator(".element-results")).toContainText("Client connection rejections");
  await expect(page.locator(".element-results")).toContainText("Server wait timeouts");
  expect((await stored(page, files.model)).content.model).toEqual(source);
});

for (const operation of ["rename", "delete connection", "delete block", "copy group", "copy service"] as const) {
  test(`keeps scenario references valid after ${operation} and undo/redo`, async ({ page, files }) => {
    const source = JSON.parse(await readFile(resolve("../apps/server/build/e2e-workspace", files.model), "utf8")) as ModelFile;
    source.blocks.gateway.scenario = [
      { type: "call", connection: "gateway-to-middle" }, { type: "call", connection: "gateway-to-middle" },
    ];
    source.blocks.middle.scenario = [{ type: "process" }, { type: "call", connection: "middle-to-dependency" }];
    await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(source));
    await page.reload();
    await expect(page.getByTestId("block-node")).toHaveCount(4);
    const expected = structuredClone(source);

    if (operation === "rename") {
      await page.getByTestId("canvas-param-gateway-to-middle-timeout").click();
      await page.getByLabel("Identifier", { exact: true }).fill("rpc");
      await page.getByLabel("Identifier", { exact: true }).press("Enter");
      expected.connections.find(edge => edge.id === "gateway-to-middle")!.id = "rpc";
      expected.blocks.gateway.scenario = [{ type: "call", connection: "rpc" }, { type: "call", connection: "rpc" }];
    } else if (operation === "delete connection" || operation === "delete block") {
      if (operation === "delete connection") {
        await page.getByTestId("canvas-param-gateway-to-middle-timeout").click();
        expected.connections = expected.connections.filter(edge => edge.id !== "gateway-to-middle");
      } else {
        await page.getByTestId("rf__node-middle").locator(".block-node > strong").click();
        delete expected.blocks.middle;
        expected.connections = expected.connections.filter(edge => edge.from !== "middle" && edge.to !== "middle");
      }
      await page.keyboard.press("Delete");
      delete expected.blocks.gateway.scenario;
    } else {
      await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
      expected.blocks["service-1"] = structuredClone(source.blocks.gateway);
      if (operation === "copy group") {
        await page.getByTestId("rf__node-middle").locator(".block-node > strong").click({ modifiers: ["ControlOrMeta"] });
        expected.blocks["service-1"].scenario = [
          { type: "call", connection: "service-1-to-service-2" }, { type: "call", connection: "service-1-to-service-2" },
        ];
        expected.blocks["service-2"] = { ...structuredClone(source.blocks.middle), scenario: [{ type: "process" }] };
        expected.connections.push({ ...structuredClone(source.connections[1]), id: "service-1-to-service-2", from: "service-1", to: "service-2" });
      } else {
        delete expected.blocks["service-1"].scenario;
      }
      await page.keyboard.press("ControlOrMeta+c");
      await page.keyboard.press("ControlOrMeta+v");
    }

    async function persistAndValidate() {
      await save(page);
      const response = await page.request.post("/api/v1/validate", { data: { experiment: files.experiment } });
      expect(response.ok()).toBe(true);
      const validation = await response.json();
      expect(validation.diagnostics.filter((item: { code: string }) => item.code === "SCENARIO_CONNECTION")).toEqual([]);
      return JSON.parse(await readFile(resolve("../apps/server/build/e2e-workspace", files.model), "utf8")) as ModelFile;
    }

    expect(await persistAndValidate()).toEqual(expected);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await persistAndValidate()).toEqual(source);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect(await persistAndValidate()).toEqual(expected);
  });
}

test("opens saves and runs a load profile without losing points", async ({ page, files }) => {
  const profiled = (await stored(page, files.model)).content.model as ModelFile;
  const load = { points: [{ time: "0s", rate: "120/s" }, { time: "1s", rate: "180/s" }] };
  profiled.blocks.client.params.load = load;
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(profiled));
  await page.reload();
  await page.getByTestId("rf__node-client").locator(".block-node > strong").click();
  const points = page.getByRole("table", { name: "Load points" }).locator("tbody tr");
  await expect(points).toHaveCount(load.points.length);
  for (const [index, point] of load.points.entries()) {
    await expect(points.nth(index).getByRole("textbox", { name: "Time", exact: true })).toHaveValue(point.time);
    await expect(points.nth(index).getByRole("textbox", { name: "Intensity", exact: true })).toHaveValue(point.rate);
  }
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
  await expect(page.locator(".element-results")).toContainText("Connection utilization");
  await expect(page.locator(".element-results")).toContainText("Mean query queue");
  await expect(page.locator(".element-results")).toContainText("Query rejection share");
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

test("opens saves and runs a call pool without losing its configuration", async ({ page, files }) => {
  const pooled = (await stored(page, files.model)).content.model as ModelFile;
  pooled.connections.find(edge => edge.id === "gateway-to-middle")!.params.pool = { size: 2, acquireTimeout: "5ms" };
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(pooled));
  await page.reload();
  await page.getByTestId("canvas-param-gateway-to-middle-timeout").click();
  await expect(page.getByLabel("Pool size", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Acquisition timeout", { exact: true })).toHaveValue("5ms");
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await page.getByLabel("Handlers", { exact: true }).fill("5");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await save(page);
  pooled.blocks.gateway.params.handlers = 5;
  expect((await stored(page, files.model)).content.model).toEqual(pooled);
  await page.reload();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  expect((await stored(page, files.model)).content.model).toEqual(pooled);
});

test("opens saves and runs a router with three weighted outputs without losing routing parameters", async ({ page, files }) => {
  const routed = (await stored(page, files.model)).content.model as ModelFile;
  expect(routed.schemaVersion).toBe(7);
  routed.blocks.router = { type: "router", params: { policy: "random" }, description: null, notes: null, scenario: null, replicaOverrides: null };
  routed.blocks.gateway.scenario = [
    { type: "process", processing: { kind: "fixed", mean: "2ms" }, failureRate: "0%", connection: null, classes: null },
    { type: "call", connection: "gateway-to-middle", processing: null, failureRate: null, classes: null },
    { type: "process", processing: null, failureRate: null, connection: null, classes: null },
    { type: "call", connection: "gateway-to-middle", processing: null, failureRate: null, classes: null },
  ];
  routed.blocks.third = structuredClone(routed.blocks.dependency);
  const call = routed.connections.find(edge => edge.id === "gateway-to-middle")!;
  call.to = "router";
  call.params.retryTarget = "other";
  routed.connections.push(...["middle", "dependency", "third"].map((to, index) => ({
    id: `route-${to}`, type: "route", from: "router", to, params: { weight: index + 1 }, description: null, notes: null, classes: null,
  })));
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify(routed));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(6);
  const expected = (await stored(page, files.model)).content.model as ModelFile;
  await expect(page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Router", exact: true })).toBeVisible();
  await page.getByTestId("rf__node-router").locator(".block-node > strong").click();
  await page.getByLabel("Policy", { exact: true }).selectOption("leastInFlight");
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await page.getByLabel("Handlers", { exact: true }).fill("5");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await save(page);
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
  await page.getByRole("button", { name: "Run settings", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Run", exact: true })).toHaveAttribute("title", "Fix validation errors before running");

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
  await expect(timeout).toHaveText("80 ms");

  await timeout.dblclick();
  await input.fill("90ms");
  await input.press("Enter");
  await expect(timeout).toHaveText("90 ms");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(timeout).toHaveText("80 ms");

  const edge = page.getByTestId("rf__edge-gateway-to-middle");
  await page.locator(".react-flow__pane").click({ position: { x: 15, y: 100 } });
  await expect(edge).not.toHaveClass(/selected/);
  await page.getByTestId("canvas-edge-label-gateway-to-middle").click({ position: { x: 3, y: 3 } });
  await expect(edge).toHaveClass(/selected/);
  await timeout.dblclick();
  await input.fill("95ms");
  await input.press("Enter");
  await expect(timeout).toHaveText("95 ms");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(timeout).toHaveText("80 ms");

  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await timeout.dblclick();
  await input.fill("100ms");
  await input.press("Enter");
  await expect(timeout.getByRole("button")).toHaveText("100 ms");
  await expect(timeout.locator("del")).toHaveText("80 ms");
  await save(page);

  const experiment = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  expect(experiment.variants.find((variant) => variant.id === "no-retries")!.overrides["gateway-to-middle.timeout"]).toBe("100ms");
  expect((await stored(page, files.model)).content.model).toEqual(originalModel);

  await page.reload();
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await expect(timeout.getByRole("button")).toHaveText("100 ms");
  await expect(timeout.locator("del")).toHaveText("80 ms");
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

  await alert.getByRole("button", { name: "Reload", exact: true }).click();
  const reloadConfirmation = page.getByRole("dialog", { name: "Reload and discard unsaved changes to the documents?", exact: true });
  await expect(reloadConfirmation.getByRole("button")).toHaveText(["Stay", "Reload and discard edits"]);
  await reloadConfirmation.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(handlers).toHaveValue("6");
  await expect(alert).toBeVisible();

  await alert.getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByRole("dialog", { name: "Reload and discard unsaved changes to the documents?", exact: true })
    .getByRole("button", { name: "Reload and discard edits", exact: true }).click();
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

test("ignores a delayed loaded version after reload and save but reports a new external version", async ({ page, files }) => {
  await writeHandlers(files, 9);
  const known = await stored(page, files.model);
  await page.reload();
  await page.getByTestId("rf__node-gateway").click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  await expect(handlers).toHaveValue("9");

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const waiting = new Promise<void>(resolve => { captured = resolve; });
  let processed!: () => void;
  const reconciled = new Promise<void>(resolve => { processed = resolve; });
  const changes = /\/api\/v1\/workspace\/changes\?/;
  let polls = 0;
  await page.route(changes, async route => {
    const call = ++polls;
    const response = await route.fetch();
    const body = await response.json();
    if (call >= 3) {
      // The next poll starts only after the retried response has been classified.
      processed();
      await route.fulfill({ response, json: { ...body, reset: false, changes: [] } });
      return;
    }
    if (call === 1) {
      captured();
      await gate;
    }
    await route.fulfill({ response, json: { ...body, reset: false, changes: [
      { path: files.model, kind: "MODEL", version: known.version },
    ] } });
  });
  try {
    await waiting;
    await handlers.fill("7");
    await handlers.press("Enter");
    await save(page);
    release();
    await reconciled;

    const alert = page.getByRole("alert").filter({ hasText: files.model });
    await expect(alert).toHaveCount(0);
    expect((await stored(page, files.model)).content.model.blocks.gateway.params.handlers).toBe(7);
    await page.unrouteAll({ behavior: "wait" });
    await writeHandlers(files, 11);
    await expect(alert).toContainText("The document changed on disk", { timeout: 5000 });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

async function writeHandlers(files: Files, value: number) {
  const path = resolve("../apps/server/build/e2e-workspace", files.model);
  const source: ModelFile = JSON.parse(await readFile(path, "utf8"));
  source.blocks.gateway.params.handlers = value;
  await writeFile(path, JSON.stringify(source));
}

async function stored(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  expect(response.ok(), `HTTP ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".dirty-mark")).toBeHidden();
}
async function connect(page: Page, from: string, to: string, targetPort = "in") {
  const source = page.getByTestId(`rf__node-${from}`).locator('[data-handleid="out"]');
  const target = page.getByTestId(`rf__node-${to}`).locator(`[data-handleid="${targetPort}"]`);
  // React Flow disables other output handles during a drag; this negative case releases on the owning node.
  await dragConnection(source, target, targetPort === "out" ? { releaseTarget: page.getByTestId(`rf__node-${to}`) } : {});
}

test("shows one palette tooltip for mouse hover or keyboard focus", async ({ page }) => {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  const palette = page.getByRole("complementary", { name: "Palette" });
  const help = palette.getByRole("button", { name: "Connect blocks", exact: true });
  const database = palette.getByRole("button", { name: "Database", exact: true });
  const helpTooltip = palette.locator(".palette-help > .palette-tooltip");
  const databaseTooltip = palette.locator(".palette-tooltip").filter({ hasText: /^Database/ });

  await help.click();
  await expect(helpTooltip).toBeVisible();
  await database.hover();
  await expect(help).toBeFocused();
  await expect(helpTooltip).toBeHidden();
  await expect(databaseTooltip).toBeVisible();
  await expect(databaseTooltip).toHaveText("Database");
  await expect(palette.getByRole("tooltip")).toHaveCount(1);
  await database.click();
  await expect(page.getByRole("dialog", { name: "About Database", exact: true })).toBeVisible();
  await expect(databaseTooltip).toBeHidden();
  await database.click();
  await page.mouse.move(0, 0);
  await expect(database).toBeFocused();
  await expect(palette.getByRole("tooltip")).toHaveCount(0);

  await database.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(database).toBeFocused();
  await expect(databaseTooltip).toBeVisible();
  await help.hover();
  await expect(helpTooltip).toBeVisible();
  await expect(databaseTooltip).toBeHidden();
  await expect(palette.getByRole("tooltip")).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(databaseTooltip).toBeVisible();
  await help.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(help).toBeFocused();
  await expect(helpTooltip).toBeVisible();
  await expect(palette.getByRole("tooltip")).toHaveCount(1);
  await help.click();
  await page.mouse.move(0, 0);
  await expect(help).toBeFocused();
  await expect(palette.getByRole("tooltip")).toHaveCount(0);

  await database.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(databaseTooltip).toBeVisible();
  await database.click();
  await database.click();
  await page.mouse.move(0, 0);
  await expect(database).toBeFocused();
  await expect(palette.getByRole("tooltip")).toHaveCount(0);

  await page.getByRole("button", { name: "View", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(palette.getByRole("button", { name: "Client", exact: true })).toBeFocused();
  await expect(palette.getByRole("tooltip", { name: "Client", exact: true })).toBeVisible();
});

test("inspects a palette block without changing the model and inserts it once with a double click", async ({ page, files }) => {
  const source = (await stored(page, files.model)).content.model as ModelFile;
  const service = page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service", exact: true });
  await service.click();
  const card = page.getByRole("dialog", { name: "About Service", exact: true });
  await expect(card).toBeVisible();
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect((await stored(page, files.model)).content.model).toEqual(source);
  await card.getByRole("button", { name: "Type help", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Service", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await service.dblclick();
  const node = page.getByTestId("rf__node-service-1");
  await expect(node).toHaveClass(/selected/);
  await expect(page.getByTestId("block-node")).toHaveCount(5);
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(node).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await save(page);
  const saved = (await stored(page, files.model)).content.model as ModelFile;
  expect(Object.keys(saved.blocks)).toHaveLength(5);
  expect(saved.blocks["service-1"].type).toBe("service");
});

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
  await page.setViewportSize({ width: 1440, height: 900 });
  const palette = page.getByRole("complementary", { name: "Palette" });
  const service = palette.getByRole("button", { name: "Service", exact: true });
  const canvas = page.getByLabel("Model canvas", { exact: true });
  await expect(palette).toHaveCSS("width", "48px");
  await expect(palette.getByText("Connections", { exact: true })).toHaveCount(0);
  await service.hover();
  await expect(palette.getByRole("tooltip", { name: "Service", exact: true })).toBeVisible();
  await page.locator(".react-flow__controls-zoomout").click();
  const pan = await canvas.evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element.querySelector(".react-flow__viewport")!).transform);
    return { x: matrix.e, y: matrix.f };
  });
  // Move the existing chain above the visible center, leaving a free insertion point after zooming.
  const pane = canvas.locator(".react-flow__pane");
  await dragCanvas(pane, canvas, {
    sourcePosition: pane => ({ x: 200, y: pane.height - 40 }),
    targetPosition: pane => ({ x: 50, y: pane.height - 280 }),
  });
  await expect.poll(() => canvas.evaluate((element, start) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element.querySelector(".react-flow__viewport")!).transform);
    return { x: Math.round(matrix.e - start.x), y: Math.round(matrix.f - start.y) };
  }, pan)).toEqual({ x: -150, y: -240 });
  const center = await canvas.evaluate((element) => {
    const viewport = element.querySelector(".react-flow__viewport")!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const box = element.getBoundingClientRect();
    return { x: (box.width / 2 - matrix.e) / matrix.a,
      y: (box.height / 2 - matrix.f) / matrix.d };
  });
  await run.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "View", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(palette.getByRole("button", { name: "Client", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(service).toBeFocused();
  await expect(palette.getByRole("tooltip", { name: "Service", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  const node = page.getByTestId("rf__node-service-1");
  await expect(node).toHaveClass(/selected/);
  const expected = await node.evaluate((element, center) => ({
    x: Math.round((center.x - (element as HTMLElement).offsetWidth / 2) / 20) * 20,
    y: Math.round((center.y - (element as HTMLElement).offsetHeight / 2) / 20) * 20,
  }), center);
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
  await service.click();
  const card = page.getByRole("dialog", { name: "About Service", exact: true });
  await expect(card.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Type help", exact: true })).toBeEnabled();
  await service.press("Enter");
  await expect(page.getByTestId("rf__node-service-2")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await service.dblclick();
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

test("measures a new Client before collision checks with its initial values and wiring hint", async ({ page, files }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const source = (await stored(page, files.model)).content.model as ModelFile;
  const sourceLayout = (await stored(page, files.layout)).content.layout as LayoutFile;
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model),
    JSON.stringify({ ...source, blocks: { client: source.blocks.client }, connections: [] }));
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.layout),
    JSON.stringify({ ...sourceLayout, positions: { client: { x: 0, y: 200 } } }));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(1);
  // Removing the services invalidates the experiment; explicitly open Problems and wait for the canvas resize before panning.
  await page.getByRole("tab", { name: "Problems", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Problems/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const canvas = page.getByLabel("Model canvas", { exact: true });
  const delta = await canvas.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element.querySelector(".react-flow__viewport")!).transform);
    const box = element.getBoundingClientRect();
    return { x: box.width / 2 + 180 * matrix.a - matrix.e, y: box.height / 2 - 200 * matrix.d - matrix.f };
  });
  const pane = canvas.locator(".react-flow__pane");
  await dragCanvas(pane, canvas, {
    sourcePosition: { x: 20, y: 80 },
    targetPosition: { x: 20 + delta.x, y: 80 + delta.y },
  });
  await page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Client", exact: true }).dblclick();
  const incoming = page.getByTestId("rf__node-client-1");
  await expect(incoming).toHaveClass(/selected/);
  await expect(incoming).toBeInViewport({ ratio: 0.99 });
  const oldBox = (await page.getByTestId("rf__node-client").boundingBox())!;
  const newBox = (await incoming.boundingBox())!;
  await expect(incoming.locator(".block-wiring-hint")).toBeVisible();
  expect(newBox.x < oldBox.x + oldBox.width && newBox.x + newBox.width > oldBox.x &&
    newBox.y < oldBox.y + oldBox.height && newBox.y + newBox.height > oldBox.y).toBe(false);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(incoming).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("keeps the viewport fixed while a palette block is held over a resizing canvas", async ({ page, files }) => {
  const canvas = page.getByLabel("Model canvas", { exact: true });
  const drag = await canvas.evaluateHandle(element => {
    const state = { started: false, transforms: [] as string[] };
    element.addEventListener("dragover", () => {
      state.started = true;
      const viewport = element.querySelector(".react-flow__viewport")!;
      state.transforms.push(getComputedStyle(viewport).transform);
      new MutationObserver(() => state.transforms.push(getComputedStyle(viewport).transform))
        .observe(viewport, { attributes: true, attributeFilter: ["style"] });
    }, { capture: true, once: true });
    return state;
  });
  const service = page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service", exact: true });
  await dragPaletteBlock(service, canvas, bounds => ({ x: bounds.width * 0.55, y: bounds.height * 0.5 }), async (_, bounds) => {
    expect(await drag.evaluate(state => state.started)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await canvas.boundingBox())!.height).not.toBe(bounds.height);
    await canvas.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const transforms = await drag.evaluate(state => state.transforms);
    expect(new Set(transforms)).toEqual(new Set([transforms[0]]));
    await drag.dispose();
  });
  await expect(page.getByTestId("rf__node-service-1")).toBeVisible();
  await save(page);
  expect((await stored(page, files.model)).content.model.blocks["service-1"].type).toBe("service");
});

test("extends the chain through real drag and ports, persists positions and commits a move as one layout-only command", async ({ page, files }) => {
  const canvas = page.getByLabel("Model canvas", { exact: true });
  // Automatic fitting can finish during a palette drag; sample the actual drop before React handles it.
  const drop = await canvas.evaluateHandle(element => {
    const coordinates = { position: null as { x: number; y: number } | null };
    element.addEventListener("drop", event => {
      const { clientX, clientY } = event as DragEvent;
      const bounds = element.getBoundingClientRect();
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element.querySelector(".react-flow__viewport")!).transform);
      coordinates.position = { x: Math.round((clientX - bounds.left - matrix.e) / matrix.a / 20) * 20,
        y: Math.round((clientY - bounds.top - matrix.f) / matrix.d / 20) * 20 };
    }, { capture: true, once: true });
    return coordinates;
  });
  await dragPaletteBlock(
    page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service", exact: true }),
    canvas, bounds => ({ x: Math.round(bounds.width * 0.55), y: Math.round(bounds.height * 0.7) }),
  );
  const expectedDrop = await drop.evaluate(coordinates => coordinates.position);
  await drop.dispose();
  const node = page.getByTestId("rf__node-service-1");
  await expect(node).toBeVisible();
  await expect(node).toHaveClass(/selected/);
  await page.getByLabel("Handlers", { exact: true }).fill("2");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await expect(page.getByLabel("Distribution", { exact: true })).toHaveValue("exponential");
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
  expect(initial.content.model.blocks["service-1"].params).toEqual({
    handlers: 2, queue: 100, processing: { kind: "fixed", mean: "2ms" }, failureRate: "0%", replicas: 1,
  });
  expect(initial.content.model.connections.at(-1)).toMatchObject({ id: "dependency-to-service-1", from: "dependency", to: "service-1", type: "call", params: { timeout: "80ms" } });
  expect(layout.positions["service-1"].x % 20).toBe(0);
  expect(layout.positions["service-1"].y % 20).toBe(0);
  expect(layout.positions["service-1"]).toEqual(expectedDrop);
  await page.reload();
  await expect(node).toBeVisible();
  await expect(edge).toBeAttached();
  await dragNode(node, { x: -60, y: -60 });
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

test("keeps automatic connection ids and references after building, renaming, saving and running a chain", async ({ page, files }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const source = (await stored(page, files.model)).content.model as ModelFile;
  const execution = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.model), JSON.stringify({
    ...source, blocks: { client: source.blocks.client }, connections: [],
  }));
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.layout), JSON.stringify({ schemaVersion: 2, sizes: {}, edges: {}, positions: { client: { x: 0, y: 100 } } }));
  await writeFile(resolve("../apps/server/build/e2e-workspace", files.experiment), JSON.stringify({
    ...execution, variants: [{ id: "baseline", label: "Baseline", overrides: {} }], faults: [], grid: [],
    execution: { ...execution.execution, replications: 2, warmup: "0ms", measurement: "300ms", window: "50ms" },
  }));
  await page.reload();
  await expect(page.getByTestId("block-node")).toHaveCount(1);
  const service = page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service", exact: true });
  await service.dblclick();
  await service.dblclick();
  await page.locator(".react-flow__controls-fitview").click();
  await connect(page, "client", "service-1");
  await connect(page, "service-1", "service-2");
  await page.getByTestId("rf__node-service-1").locator(".block-node > strong").click();
  await page.getByRole("button", { name: "Set custom scenario", exact: true }).click();
  await page.getByTestId("canvas-edge-label-service-1-to-service-2").click();
  await page.getByRole("button", { name: "Add fault", exact: true }).click();
  for (const [id, next] of [["service-1", "catalog"], ["service-2", "pricing"]]) {
    await page.getByTestId(`rf__node-${id}`).locator(".block-node > strong").click();
    await page.getByLabel("Identifier", { exact: true }).fill(next);
    await page.getByLabel("Identifier", { exact: true }).press("Enter");
    await expect(page.getByTestId(`rf__node-${next}`)).toBeVisible();
    if (id === "service-1") {
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(page.getByTestId("rf__edge-service-1-to-service-2")).toBeAttached();
      await expect(page.getByTestId("rf__node-catalog")).toHaveCount(0);
      await page.getByRole("button", { name: "Redo", exact: true }).click();
    }
  }
  await save(page);
  const savedModel = (await stored(page, files.model)).content.model as ModelFile;
  const savedExperiment = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  expect(savedModel.connections.map(connection => connection.id)).toEqual(["client-to-catalog", "catalog-to-pricing"]);
  expect(savedModel.blocks.catalog.scenario![1].connection).toBe("catalog-to-pricing");
  expect(savedExperiment.faults[0].target).toBe("catalog-to-pricing");
  expect(JSON.stringify([savedModel, savedExperiment])).not.toMatch(/service-[12]/);
  await page.reload();
  await expect(page.getByTestId("rf__edge-catalog-to-pricing")).toBeAttached();
  await page.getByTestId("rf__node-catalog").locator(".block-node > strong").click();
  await expect(page.getByRole("combobox", { name: "Connection", exact: true })).toHaveValue("catalog-to-pricing");
  const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const result: RunSummary = await (await response).json();
  expect(result.variants[0].points[0].aggregate.connections["catalog-to-pricing"].totals.sentAttempts).toBeGreaterThan(0);
  expect(result.variants[0].points[0].aggregate.connections).not.toHaveProperty("service-1-to-service-2");
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  await page.evaluate(() => localStorage.setItem("resilience-lab.language", "ru"));
  await page.reload();
  await page.getByRole("tab", { name: "Модель", exact: true }).click();
  await page.getByTestId("rf__node-catalog").locator(".block-node > strong").click();
  await page.locator(".inspector-parameters > summary").click();
  await expect(page.getByRole("combobox", { name: "Связь", exact: true }).locator("option:checked"))
    .toHaveText("catalog → pricing (catalog-to-pricing)");
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  await page.mouse.move(700, 70);
  await page.screenshot({ path: testInfo.outputPath("link-rename-scenario-ru.png") });
  await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Цель отказа", exact: true }).locator("option:checked"))
    .toHaveText("Связь catalog → pricing (catalog-to-pricing)");
  await page.locator(".inspector-execution > summary").click();
  await page.mouse.move(700, 70);
  await page.screenshot({ path: testInfo.outputPath("link-rename-fault-ru.png") });
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
  expect(renamedModel.connections.find((edge) => edge.id === "middle-to-storage")!.to).toBe("storage");
  expect(renamedExperiment.faults[0].target).toBe("storage");
  expect(renamedLayout.positions.storage).toEqual({ x: 780, y: 100 });
  expect(renamedLayout.positions.dependency).toBeUndefined();
  await page.getByTestId("rf__node-middle").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("rf__node-middle")).toHaveCount(0);
  await expect(page.getByTestId("rf__edge-gateway-to-middle")).toHaveCount(0);
  await expect(page.getByTestId("rf__edge-middle-to-storage")).toHaveCount(0);
  await save(page);
  const deletedExperiment = (await stored(page, files.experiment)).content.experiment as ExperimentFile;
  expect(deletedExperiment.variants.find((variant) => variant.id === "no-retries")!.overrides).toEqual({});
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("rf__node-middle")).toBeVisible();
  await expect(page.getByTestId("rf__edge-middle-to-storage")).toBeAttached();
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
  await dragNode(gateway, { x: 0, y: 60 });
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
  await page.getByRole("complementary", { name: "Palette" }).getByRole("button", { name: "Service" }).click();
  const card = page.getByRole("dialog", { name: "About Service", exact: true });
  await expect(card.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Type help", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("block-node")).toHaveCount(4);
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
  await expect(inspector.locator(".param-description")).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "More about: Handlers", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("after-element.png") });

  await page.locator(".react-flow__pane").click({ position: { x: 15, y: 15 } });
  await expect(inspector.getByRole("heading", { name: "Run settings" })).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Parameter sweep" })).toBeVisible();
  await gateway.click();
  await page.getByRole("button", { name: "Run settings", exact: true }).click();
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
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
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


test("inserts a database with explicit initial values and a wiring hint, then connects it", async ({ page, files }) => {
  const palette = page.getByRole("complementary", { name: "Palette" });
  const run = page.getByRole("button", { name: "Run", exact: true });
  await palette.getByRole("button", { name: "Database", exact: true }).dblclick();
  const database = page.getByTestId("rf__node-database-1");
  await expect(database).toBeVisible();
  await expect(page.getByLabel("Maximum connections", { exact: true })).toHaveValue("100");
  await expect(page.getByLabel("Mean", { exact: true })).toHaveValue("5ms");
  await expect(database.locator(".block-wiring-hint")).toHaveText("Connect this block to the model");
  await expect(database.locator(".diagnostic--error")).toHaveCount(0);
  await page.getByRole("tab", { name: "Problems", exact: true }).click();
  await expect(page.locator(".validation-problems")).not.toContainText("PARAM_");
  await expect(run).toHaveAttribute("title", "Fix validation errors before running");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(database).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(database.locator(".block-wiring-hint")).toBeVisible();
  await page.getByRole("button", { name: /fit view/i }).click();
  await connect(page, "dependency", "database-1");
  await expect(database.locator(".block-wiring-hint")).toHaveCount(0);
  await save(page);
  await expect(run).toBeEnabled();
  const saved = (await stored(page, files.model)).content.model as ModelFile;
  expect(saved.blocks["database-1"].params).toEqual({
    maxConnections: 100, queue: 0, processing: { kind: "exponential", mean: "5ms" }, failureRate: "0%",
  });
  expect(saved.connections.find(connection => connection.to === "database-1")?.params).toEqual({
    network: { kind: "fixed", mean: "1ms" }, timeout: "1s", attempts: 1, retryTarget: "any", backoff: { kind: "none" },
  });
});
