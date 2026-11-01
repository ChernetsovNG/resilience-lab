import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile } from "../src/api/apiTypes";
import { readWorkspaceDocument, cleanupWorkspace, copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10_000 });

test("creates, changes, persists and runs a replica fault from its inspector", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
  const directory = `fault-editor-${randomUUID()}`;
  const root = resolve("../apps/server/build/e2e-workspace", directory);
  await mkdir(root);
  try {
    const experiment = await copySmallExperiment(root);
    experiment.execution = { ...experiment.execution, replications: 1, warmup: "0s", measurement: "40s", window: "1s" };
    experiment.variants = experiment.variants.filter(variant => variant.id === "baseline");
    experiment.faults = [];
    const modelPath = resolve(root, "retry-storm.model.json");
    const model: ModelFile = JSON.parse(await readFile(modelPath, "utf8"));
    model.blocks.gateway.params.replicas = 3;
    model.blocks.client.params.load = { points: [{ time: "0s", rate: "10/s" }] };
    await writeFile(modelPath, JSON.stringify(model));
    await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
    await page.goto("/");
    await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
    const canvas = page.getByRole("application", { name: "Полотно модели", exact: true });
    const before = await canvas.boundingBox();
    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });
    await inspector.getByRole("combobox", { name: "Цель отказа", exact: true }).selectOption("gateway#2");
    await inspector.getByRole("button", { name: "Добавить отказ", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.mouse.move(700, 200);
    await page.screenshot({ path: testInfo.outputPath("fault-target-ru.png") });
    await inspector.getByRole("button", { name: "Добавить отказ", exact: true }).click();
    const fault = inspector.getByRole("group", { name: "Отказ 1", exact: true });
    await expect(inspector.getByRole("heading", { name: "Настройки прогона", exact: true })).toBeVisible();
    await expect(fault.getByRole("combobox", { name: "Цель отказа", exact: true })).toHaveValue("gateway#2");
    await fault.getByRole("combobox", { name: "Вид отказа", exact: true }).selectOption("blackhole");
    for (const [label, value] of [["Начало отказа", "20s"], ["Конец отказа", "30s"]]) {
      await fault.getByRole("textbox", { name: label, exact: true }).fill(value);
      await fault.getByRole("textbox", { name: label, exact: true }).press("Enter");
    }
    const course = page.getByRole("region", { name: "Ход эксперимента", exact: true });
    await expect(course).toContainText("gateway#2");
    await expect(course).toContainText("Чёрная дыра");
    await fault.getByRole("combobox", { name: "Вид отказа", exact: true }).selectOption("slowdown");
    const multiplier = fault.getByRole("textbox", { name: "Множитель времени обработки", exact: true });
    await multiplier.fill("4");
    await multiplier.press("Enter");
    await expect(course).toContainText("4×");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByText("Несохранённые изменения", { exact: true })).toBeHidden();
    const url = `/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.experiment.json`)}`;
    const faults = (await readWorkspaceDocument(page.request, url)).content.experiment.faults;
    expect(faults).toEqual([
      { target: "gateway#2", from: "20s", to: "30s", kind: "slowdown", multiplier: 4, delay: null, failureRate: null, capacity: null, at: null },
    ]);
    await page.reload();
    await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
    await expect(fault.getByRole("combobox", { name: "Цель отказа", exact: true })).toHaveValue("gateway#2");
    await expect(multiplier).toHaveValue("4");
    await course.getByRole("button", { name: "Ход эксперимента", exact: true }).click();
    await expect(course).toContainText("gateway#2");
    const collapse = page.getByRole("button", { name: "Свернуть результаты", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    const after = await canvas.boundingBox();
    expect({ width: after!.width, height: after!.height }).toEqual({ width: before!.width, height: before!.height });
    await writeFile(testInfo.outputPath("canvas-size.json"), JSON.stringify({ before, after }));
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.mouse.move(700, 200);
    await page.screenshot({ path: testInfo.outputPath("fault-editor-ru.png") });
    const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
    await page.getByRole("button", { name: "Запустить", exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
    await expect(course).toContainText("gateway#2");
    await expect(course).toContainText("4×");
    await page.mouse.move(700, 100);
    await page.screenshot({ path: testInfo.outputPath("fault-editor-results-ru.png") });
  } finally {
    await cleanupWorkspace(page, root);
  }
});
