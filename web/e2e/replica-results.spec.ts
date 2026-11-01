import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile, RunSummary } from "../src/api/apiTypes";
import { cleanupWorkspace, copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`group results show slow replica #2 on canvas, inspector, Answer and Map in ${language}`, async ({ page }, testInfo) => {
    const ru = language === "ru";
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const directory = `replica-results-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const experiment = await copySmallExperiment(root);
      experiment.faults = [];
      experiment.execution = { ...experiment.execution, warmup: "200ms", measurement: "1s", window: "50ms" };
      experiment.variants = [{ id: "baseline", label: "Baseline" }];
      experiment.grid = [{ path: "gateway.handlers", values: [2, 3] }];
      const modelPath = resolve(root, "retry-storm.model.json");
      const model: ModelFile = JSON.parse(await readFile(modelPath, "utf8"));
      model.blocks.gateway.params = { ...model.blocks.gateway.params, replicas: 3, handlers: 2 };
      model.blocks.gateway.replicaOverrides = { "2": { processing: { kind: "fixed", mean: "100ms" } } };
      await writeFile(modelPath, JSON.stringify(model));
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true }).click();
      const summary: RunSummary = await (await response).json();
      const aggregate = summary.variants[0].points[0].aggregate;
      const pool = aggregate.services.gateway.totals.slotPools.handlers;
      expect(pool.replicaExtrema!.maxUtilizationReplica).toBe(2);
      expect(pool.replicaExtrema!.maxUtilization!).toBeGreaterThan(pool.busyIntegralMs / pool.capacityIntegralMs);
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      const node = page.getByTestId("rf__node-gateway");
      const metrics = page.getByTestId("canvas-results-gateway");
      await expect(metrics).toContainText(ru ? "худшая #2" : "worst #2");
      await node.locator(".block-node > strong").click();
      const inspector = page.getByRole("complementary", { name: ru ? "Инспектор" : "Inspector" });
      const table = inspector.getByRole("table", { name: ru ? "Реплики · gateway" : "Replicas · gateway", exact: true });
      await expect(table).toBeVisible();
      await expect(table.getByRole("row").filter({ has: page.getByRole("button", { name: "gateway#2", exact: true }) }).locator("td").last())
        .not.toHaveText(ru ? "нет данных" : "n/a");
      await table.getByRole("button", { name: ru ? "Загрузка ресурса" : "Resource utilization", exact: true }).click();
      await expect(table.getByRole("row").nth(1)).toContainText("#2");
      const geometry = async () => ({
        canvas: await page.locator(".react-flow").evaluate(element => ({ width: element.clientWidth, height: element.clientHeight })),
        group: await node.evaluate(element => ({ height: (element as HTMLElement).offsetHeight,
          bodyHeight: element.querySelector<HTMLElement>(".block-node")!.offsetHeight })),
        service: await page.getByTestId("rf__node-middle").evaluate(element => ({ height: (element as HTMLElement).offsetHeight,
          bodyHeight: element.querySelector<HTMLElement>(".block-node")!.offsetHeight })),
      });
      const before = await geometry();
      expect(before.group.bodyHeight).toBe(before.service.bodyHeight);
      expect(before.group.height - before.service.height).toBe(8);
      await page.mouse.move(500, 80);
      if (ru) await page.screenshot({ path: testInfo.outputPath("replica-group-ru.png") });
      await table.getByRole("button", { name: "gateway#2", exact: true }).click();
      await expect(inspector.getByRole("heading", { name: "gateway#2", exact: true })).toBeVisible();
      await expect(inspector.getByRole("combobox", { name: ru ? "Цель отказа" : "Fault target", exact: true })).toHaveValue("gateway#2");
      if (ru) {
        await inspector.getByRole("combobox", { name: "Цель отказа", exact: true }).scrollIntoViewIfNeeded();
        await page.mouse.move(500, 80);
        await page.screenshot({ path: testInfo.outputPath("fault-target-ru.png") });
      }
      await expect(node.locator(".block-selected-replica")).toContainText("#2");
      const differences = inspector.locator(".inspector-replicaOverrides");
      if (!await differences.evaluate(element => (element as HTMLDetailsElement).open))
        await differences.locator("summary").click({ position: { x: 5, y: 5 } });
      await expect(differences.getByRole("textbox", { name: ru ? "Среднее" : "Mean", exact: true })).toHaveValue("100ms");
      await expect(differences.getByRole("textbox", { name: ru ? "Среднее" : "Mean", exact: true })).toHaveAttribute("readonly", "");
      expect(await geometry()).toEqual(before);
      await writeFile(testInfo.outputPath("replica-results-geometry.json"), JSON.stringify(before, null, 2));
      const group = page.locator(".answer > .summary-services").filter({ has: page.locator("summary", { hasText: ru ? "Группа: gateway" : "Group: gateway" }) });
      await group.locator(":scope > summary").click();
      const replica = group.locator(".summary-services").filter({ has: page.locator("summary", { hasText: "gateway#2" }) });
      await replica.locator("summary").click();
      await expect(replica.getByRole("table")).toBeVisible();
      await expect(inspector.getByRole("heading", { name: "gateway#2", exact: true })).toBeVisible();
      await expect(inspector.getByRole("combobox", { name: ru ? "Цель отказа" : "Fault target", exact: true })).toHaveValue("gateway#2");
      if (ru) await page.screenshot({ path: testInfo.outputPath("replica-answer-ru.png") });
      await page.getByRole("tab", { name: ru ? "Карта" : "Map", exact: true }).click();
      await page.getByRole("combobox", { name: ru ? "Показатель карты" : "Map metric", exact: true }).selectOption("handlerUtilization");
      await page.getByRole("combobox", { name: ru ? "Элемент на карте" : "Element on map", exact: true }).selectOption("gateway");
      const replicas = page.locator(".map-replicas");
      await replicas.locator("summary").click();
      await replicas.getByRole("radio", { name: "gateway#2", exact: true }).check();
      await expect(inspector.getByRole("heading", { name: "gateway#2", exact: true })).toBeVisible();
      await expect(inspector.getByRole("combobox", { name: ru ? "Цель отказа" : "Fault target", exact: true })).toHaveValue("gateway#2");
      if (ru) await page.screenshot({ path: testInfo.outputPath("replica-map-ru.png") });
      await expect(page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: ru ? "Отменить действие" : "Undo", exact: true })).toBeDisabled();
      expect(JSON.parse(await readFile(modelPath, "utf8"))).toEqual(model);
    } finally { await cleanupWorkspace(page, root); }
  });
}
