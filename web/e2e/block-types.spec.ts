import { expect, test as base, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExperimentFile, LayoutFile, ModelFile } from "../src/api/apiTypes";
import { selectExperiment } from "./fixtures";

const test = base.extend<{ graph: { directory: string; model: ModelFile } }>({
  graph: async ({ page }, provide) => {
    const directory = `block-types-${randomUUID()}`;
    const target = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(target);
    const model: ModelFile = JSON.parse(await readFile("../examples/retry-storm/retry-storm.model.json", "utf8"));
    model.blocks = {
      client: model.blocks.client,
      entry: structuredClone(model.blocks.gateway),
      router: { type: "router", params: { policy: "roundRobin" } },
      service: structuredClone(model.blocks.gateway),
      pooler: { type: "pooler", params: { maxClientConnections: 100, poolSize: 20, waitTimeout: "50ms" } },
      database: { type: "database", params: { maxConnections: 3, queue: 4, processing: { kind: "fixed", mean: "5ms" } } },
    };
    model.connections = [
      // The current request type admits a client only to a service.
      { id: "request", from: "client", to: "entry", type: "request", params: {} },
      { id: "dispatch", from: "entry", to: "router", type: "call", params: { timeout: "200ms", attempts: 1 } },
      { id: "route", from: "router", to: "service", type: "route", params: {} },
      { id: "pooled-call", from: "service", to: "pooler", type: "call", params: {
        timeout: "100ms", attempts: 1, pool: { size: 10, acquireTimeout: "20ms" },
      } },
      { id: "query", from: "pooler", to: "database", type: "call", params: { timeout: "50ms", attempts: 1 } },
    ];
    const layout: LayoutFile = { schemaVersion: 1, positions: {
      client: { x: 0, y: 32 }, entry: { x: 240, y: 32 }, router: { x: 480, y: 32 },
      service: { x: 680, y: 32 }, pooler: { x: 920, y: 32 }, database: { x: 1160, y: 32 },
    } };
    const experiment: ExperimentFile = JSON.parse(await readFile("../examples/retry-storm/retry-storm.experiment.json", "utf8"));
    experiment.modelRef = "types.model.json";
    experiment.layoutRef = "types.layout.json";
    experiment.execution = { ...experiment.execution, replications: 2, warmup: "0ms", measurement: "2s", window: "100ms" };
    experiment.variants = [{ id: "baseline", label: "Типы блоков" }];
    experiment.faults = [];
    await Promise.all([
      writeFile(resolve(target, "types.model.json"), JSON.stringify(model)),
      writeFile(resolve(target, "types.layout.json"), JSON.stringify(layout)),
      writeFile(resolve(target, "types.experiment.json"), JSON.stringify(experiment)),
    ]);
    try {
      await page.goto("/");
      await selectExperiment(page, `${directory}/types.experiment.json`);
      await expect(page.getByTestId("block-node")).toHaveCount(6);
      const stored = await page.request.get(`/api/v1/workspace/document?path=${directory}/types.model.json`);
      await provide({ directory, model: (await stored.json()).content.model });
    } finally { await rm(target, { recursive: true }); }
  },
});

test.use({ locale: "ru-RU", viewport: { width: 1440, height: 900 }, actionTimeout: 10_000 });

async function geometry(page: Page) {
  return page.locator(".react-flow").evaluate(element => ({
    canvas: { width: element.clientWidth, height: element.clientHeight },
    nodes: [...element.querySelectorAll<HTMLElement>(".react-flow__node")].map(node => ({
      id: node.dataset.id!, width: node.offsetWidth, height: node.offsetHeight,
      shape: node.querySelector(".block-shape")!.className,
    })),
  }));
}

async function save(page: Page, language: "en" | "ru" = "ru") {
  const button = page.getByRole("button", { name: language === "en" ? "Save" : "Сохранить", exact: true });
  await button.click();
  await expect(page.getByText(language === "en" ? "Unsaved changes" : "Несохранённые изменения", { exact: true })).toBeHidden();
  await expect(button).toBeDisabled();
}

test("typed nodes preserve document edits, Undo, result overlays and compact footprints", async ({ page, graph }, testInfo) => {
  for (const [id, shape] of [["client", "person"], ["entry", "card"], ["router", "circle"], ["service", "card"], ["pooler", "double"], ["database", "cylinder"]]) {
    const node = page.getByTestId(`rf__node-${id}`);
    await expect(node.locator(`.block-shape--${shape}`)).toBeVisible();
    await expect(node.locator(".block-type-icon svg")).toBeVisible();
    await expect(node.locator(".react-flow__handle-right")).toHaveCount(id === "database" ? 0 : 1);
    await expect(node.locator(".react-flow__handle-left")).toHaveCount(id === "client" ? 0 : 1);
  }
  await expect(page.getByTestId("canvas-param-pooler-poolSize")).toHaveText("20");
  await expect(page.getByTestId("canvas-param-router-policy")).toHaveText("По кругу");
  await expect(page.getByTestId("canvas-edge-label-pooled-call")).toContainText("пул 10");
  const policy = page.getByTestId("canvas-param-router-policy");
  await policy.dblclick();
  await policy.locator("select").selectOption("leastInFlight");
  await save(page);
  const routed = await page.request.get(`/api/v1/workspace/document?path=${graph.directory}/types.model.json`);
  expect((await routed.json()).content.model.blocks.router.params.policy).toBe("leastInFlight");
  const bounds = await policy.evaluate(element => {
    const body = element.closest(".block-shape")!.getBoundingClientRect();
    const value = element.getBoundingClientRect();
    const hint = element.parentElement!.querySelector(".help-hint-button")!.getBoundingClientRect();
    return { bodyRight: body.right, valueRight: value.right, hintRight: hint.right,
      rowWidth: element.parentElement!.getBoundingClientRect().width,
      rowMinimum: getComputedStyle(element.parentElement!).minWidth };
  });
  expect(bounds.valueRight, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.bodyRight - 4);
  expect(bounds.hintRight, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.bodyRight - 4);
  await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
  await save(page);
  const connections = page.getByTestId("canvas-param-database-maxConnections");
  await connections.dblclick();
  await connections.locator("input").fill("7");
  await connections.locator("input").press("Enter");
  await expect(connections).toHaveText("7");
  await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
  await expect(connections).toHaveText("3");
  await expect(page.getByRole("button", { name: "Отменить действие", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await save(page);
  const document = async (name: string) => (await page.request.get(`/api/v1/workspace/document?path=${graph.directory}/types.${name}.json`)).json();
  graph.model.blocks.database.params.maxConnections = 7;
  expect((await document("model")).content.model).toEqual(graph.model);
  await page.reload();
  await expect(connections).toHaveText("7");
  const before = await geometry(page);
  await page.screenshot({ path: testInfo.outputPath("types-editor-ru.png") });

  await page.getByRole("tab", { name: "Типы блоков", exact: true }).click();
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
  await expect(page.getByTestId("canvas-results-database")).toBeVisible();
  for (const id of ["entry", "service", "database"]) {
    await expect.poll(() => page.getByTestId(`rf__node-${id}`).locator(".block-node").evaluate(node => (node as HTMLElement).style.getPropertyValue("--node-fill"))).not.toBe("");
  }
  const after = await geometry(page);
  expect(after.nodes).toEqual(before.nodes);
  const service = after.nodes.find(node => node.id === "service")!;
  const router = after.nodes.find(node => node.id === "router")!;
  expect(router.width).toBeLessThanOrEqual(service.width);
  expect(router.height).toBeLessThanOrEqual(service.height);
  await page.screenshot({ path: testInfo.outputPath("types-results-ru.png") });
  await page.getByLabel("Показатели узлов", { exact: true }).selectOption("serverUtilization");
  await expect.poll(() => page.getByTestId("rf__node-pooler").locator(".block-node").evaluate(node => (node as HTMLElement).style.getPropertyValue("--node-fill"))).not.toBe("");
  await page.screenshot({ path: testInfo.outputPath("types-pooler-ru.png") });

  await connections.dblclick();
  await connections.locator("input").fill("9");
  await connections.locator("input").press("Enter");
  await save(page);
  expect((await document("experiment")).content.experiment.variants[0].overrides).toEqual({ "database.maxConnections": 9 });
  expect((await document("model")).content.model).toEqual(graph.model);
  await expect(page.getByTestId("rf__node-database").locator(".block-node--overridden")).toBeVisible();
  await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
  await save(page);
  expect((await document("experiment")).content.experiment.variants[0].overrides ?? {}).toEqual({});
  expect((await document("model")).content.model).toEqual(graph.model);

  await page.setViewportSize({ width: 1280, height: 800 });
  const compact = await geometry(page);
  await page.screenshot({ path: testInfo.outputPath("types-compact-ru.png") });
  const measurement = testInfo.outputPath("geometry.json");
  await writeFile(measurement, JSON.stringify({ before, after, compact }, null, 2));
  await testInfo.attach("geometry.json", { path: measurement, contentType: "application/json" });
});

for (const language of ["en", "ru"] as const) {
  test(`router variant keeps its effective policy and editor visible with Undo in ${language}`, async ({ page, graph }) => {
    await page.evaluate(language => localStorage.setItem("resilience-lab.language", language), language);
    await page.reload();
    await page.getByRole("tab", { name: "Типы блоков", exact: true }).click();
    const policy = page.getByTestId("canvas-param-router-policy");
    await policy.dblclick();
    await policy.locator("select").selectOption("leastInFlight");
    await save(page, language);
    const experiment = async () => (await (await page.request.get(`/api/v1/workspace/document?path=${graph.directory}/types.experiment.json`)).json()).content.experiment;
    expect((await experiment()).variants[0].overrides).toEqual({ "router.policy": "leastInFlight" });
    const visibleWidth = (selector: string) => policy.locator(selector).evaluate(element => {
      const current = element.getBoundingClientRect();
      const parent = element.closest(".inline-param")!.getBoundingClientRect();
      return Math.max(0, Math.min(current.right, parent.right) - Math.max(current.left, parent.left));
    });
    expect(await visibleWidth(".inline-param-value")).toBeGreaterThan(8);
    expect(await visibleWidth("del")).toBeGreaterThan(4);
    await policy.locator(".inline-param-value").dblclick();
    expect(await visibleWidth("select")).toBeGreaterThan(8);
    await policy.locator("select").press("Escape");
    await page.getByRole("button", { name: language === "en" ? "Undo" : "Отменить действие", exact: true }).click();
    await expect(policy.locator("del")).toHaveCount(0);
    await expect(policy).toHaveText(language === "en" ? "Round" : "По кругу");
    await save(page, language);
    expect((await experiment()).variants[0].overrides ?? {}).toEqual({});
    const stored = await page.request.get(`/api/v1/workspace/document?path=${graph.directory}/types.model.json`);
    expect((await stored.json()).content.model).toEqual(graph.model);
  });
}

for (const language of ["en", "ru"] as const) {
  test(`node parameters and result labels fit their fixed footprints in ${language}`, async ({ page, graph }, testInfo) => {
    const ru = language === "ru";
    graph.model.blocks.service.params.replicas = 3;
    graph.model.blocks.service.replicaOverrides = { "2": { processing: { kind: "fixed", mean: "100ms" } } };
    await writeFile(resolve("../apps/server/build/e2e-workspace", graph.directory, "types.model.json"), JSON.stringify(graph.model));
    await page.evaluate(language => localStorage.setItem("resilience-lab.language", language), language);
    await page.reload();
    await expect(page.getByTestId("rf__node-service").locator(".block-replica-count")).toHaveText("×3");
    const overflows = () => page.getByTestId("block-node").evaluateAll(nodes => nodes.flatMap(node =>
      [...node.querySelectorAll<HTMLElement>(".block-param, .inline-param, .inline-param-value, .inline-param-current, .inline-param-model, .block-results > span, .block-result-text")]
        .filter(row => !row.closest(".canvas-metrics--empty") && row.scrollWidth > row.clientWidth)
        .map(row => ({ node: node.closest<HTMLElement>(".react-flow__node")!.dataset.id,
          text: row.textContent, width: row.clientWidth, content: row.scrollWidth }))));
    const policy = page.getByTestId("canvas-param-router-policy");
    const policies = ["roundRobin", "random", "leastInFlight"];
    const full: Record<string, string> = ru
      ? { roundRobin: "По очереди", random: "Случайная", leastInFlight: "Меньше активных запросов" }
      : { roundRobin: "Round robin", random: "Random", leastInFlight: "Fewest active requests" };
    const choosePolicy = async (value: string) => {
      await policy.dblclick();
      await policy.locator("select").selectOption(value);
      await save(page, language);
      expect(await overflows()).toEqual([]);
      const row = policy.locator("..");
      await row.locator(".help-hint-button").click();
      await expect(row.getByRole("tooltip")).toContainText(full[value]);
      await page.keyboard.press("Escape");
    };
    for (const base of ["random", "leastInFlight", "roundRobin"]) {
      await page.getByRole("tab", { name: ru ? "Модель" : "Model", exact: true }).click();
      await choosePolicy(base);
      await page.getByRole("tab", { name: "Типы блоков", exact: true }).click();
      for (const value of [...policies.filter(value => value !== base), base]) await choosePolicy(value);
    }
    const before = await geometry(page);
    await page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText(ru ? "ЗАВЕРШЕНО" : "COMPLETED");
    await expect(page.getByTestId("canvas-results-pooler")).toBeVisible();
    const group = page.getByTestId("canvas-results-service");
    await expect(group.locator(".block-result-text").first()).toContainText(ru ? "макс. #2" : "max #2");
    await expect(page.getByTestId("rf__node-entry").locator(".diagnostic-badge")).toBeVisible();
    expect(await overflows()).toEqual([]);
    expect((await geometry(page)).nodes).toEqual(before.nodes);
    for (const id of ["entry", "service", "pooler", "database"]) {
      const rows = page.getByTestId(`canvas-results-${id}`).locator(":scope > span");
      await expect(rows).toHaveCount(3);
      for (const row of await rows.all()) {
        const hint = row.getByRole("button");
        await hint.focus();
        await hint.press("Enter");
        await expect(row.getByRole("tooltip")).toBeVisible();
        await expect(row.getByRole("tooltip")).toContainText(ru ? "по объединённым данным повторений" : "pooled across replications");
        if (id === "service") await expect(row.getByRole("tooltip")).toContainText(ru ? "худшая #" : "worst #");
        await page.keyboard.press("Escape");
      }
    }
    await page.locator(".react-flow__controls-fitview").click();
    await page.screenshot({ path: testInfo.outputPath(`node-labels-${language}.png`) });
  });
}
