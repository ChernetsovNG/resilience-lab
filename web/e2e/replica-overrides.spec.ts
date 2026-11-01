import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile } from "../src/api/apiTypes";
import { copySmallExperiment, expect, selectExperiment, test, removeWorkspacePath } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`persists replica #2 processing, runs the group and keeps variant structure read-only in ${language}`, async ({ page }, testInfo) => {
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const ru = language === "ru";
    const directory = `replica-overrides-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const experiment = await copySmallExperiment(root);
      experiment.faults = [];
      experiment.execution = { ...experiment.execution, warmup: "0ms", measurement: "500ms" };
      experiment.variants = [{ id: "baseline", label: "Baseline" }];
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      const document = async (kind: string) => (await (await page.request.get(
        `/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.${kind}.json`)}`,
      )).json()).content;
      const source: ModelFile = (await document("model")).model;
      const node = page.getByTestId("rf__node-gateway");
      await node.locator(".block-node > strong").click();
      const inspector = page.getByRole("complementary", { name: ru ? "Инспектор" : "Inspector" });
      const run = page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true });
      const section = inspector.locator(".inspector-replicaOverrides");
      const canvasSize = () => page.locator(".react-flow").evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
      const nodeSize = () => node.evaluate(element => ({
        width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight,
        bodyHeight: element.querySelector<HTMLElement>(".block-node")!.offsetHeight,
      }));
      const before = { canvas: await canvasSize(), node: await nodeSize() };
      const replicas = inspector.getByRole("textbox", { name: ru ? "Реплики" : "Replicas", exact: true });
      await replicas.fill("3");
      await replicas.press("Tab");
      await expect(node.locator(".block-replica-count")).toHaveText("×3");
      await section.getByRole("spinbutton", { name: ru ? "Номер реплики" : "Replica number", exact: true }).fill("2");
      await section.getByRole("button", { name: ru ? "Добавить отличие" : "Add override", exact: true }).click();
      const row = section.getByRole("row", { name: /^#2\b/ });
      const mean = row.getByRole("textbox", { name: ru ? "Среднее" : "Mean", exact: true });
      await mean.fill("35ms");
      await mean.press("Tab");
      const save = async () => {
        await page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true }).click();
        await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      };
      await save();
      const expected = { ...source, blocks: { ...source.blocks, gateway: { ...source.blocks.gateway,
        params: { ...source.blocks.gateway.params, replicas: 3 },
        replicaOverrides: { "2": { processing: { kind: "exponential", mean: "35ms" } } },
      } } };
      expect((await document("model")).model).toEqual(expected);
      for (const kind of ["lognormal", "fixed", "exponential"]) {
        await row.getByRole("combobox", { name: ru ? "Распределение" : "Distribution", exact: true }).selectOption(kind);
        await save();
        expect((await document("model")).model.blocks.gateway.replicaOverrides["2"].processing)
          .toEqual({ kind, mean: "35ms", ...(kind === "lognormal" ? { stdDev: "35ms" } : {}) });
        await expect(run).toBeEnabled();
      }
      expect((await document("model")).model).toEqual(expected);
      await page.reload();
      await node.locator(".block-node > strong").click();
      await expect(mean).toHaveValue("35ms");
      await expect(node.locator(".block-shape--replicas")).toBeVisible();
      const after = { canvas: await canvasSize(), node: await nodeSize() };
      expect(after.canvas).toEqual(before.canvas);
      expect(after.node.bodyHeight).toBe(before.node.bodyHeight);
      expect(after.node.height - before.node.height).toBe(8);
      const geometry = testInfo.outputPath("replica-geometry.json");
      await writeFile(geometry, JSON.stringify({ before, after }, null, 2));
      await testInfo.attach("replica-geometry", { path: geometry, contentType: "application/json" });
      await inspector.locator(".inspector-parameters > summary").click();
      await expect(run).toBeEnabled();
      await page.mouse.move(600, 90);
      if (ru) await page.screenshot({ path: testInfo.outputPath("replica-editor-ru.png") });
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      await node.locator(".block-node > strong").click();
      await expect(mean).toHaveAttribute("readonly", "");
      await expect(row.getByRole("button", { name: ru ? "Удалить отличие реплики 2" : "Remove override for replica 2", exact: true })).toBeDisabled();
      await inspector.locator(".inspector-parameters > summary").click();
      await replicas.fill("4");
      await replicas.press("Tab");
      await save();
      expect((await document("experiment")).experiment.variants[0].overrides).toEqual({ "gateway.replicas": 4 });
      expect((await document("model")).model).toEqual(expected);
      await expect(node.locator(".block-replica-count")).toHaveText("×4");
      await inspector.locator(".inspector-parameters > summary").click();
      await expect(run).toBeEnabled();
      await page.mouse.move(600, 90);
      if (ru) await page.screenshot({ path: testInfo.outputPath("replica-variant-ru.png") });
      await page.getByRole("button", { name: ru ? "Отменить действие" : "Undo", exact: true }).click();
      await save();
      await expect(node.locator(".block-replica-count")).toHaveText("×3");
      await expect(run).toBeEnabled();
      await run.click();
      await expect(page.getByTestId("job-status")).toHaveText(ru ? "ЗАВЕРШЕНО" : "COMPLETED");
      expect((await document("model")).model).toEqual(expected);
    } finally {
      await removeWorkspacePath(page, root);
    }
  });
}
