import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile, SeriesIndex } from "../src/api/apiTypes";
import { copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`Timeline loads a group before its chosen replica and shares playback in ${language}`, async ({ page, request }, testInfo) => {
    const ru = language === "ru";
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const directory = `timeline-groups-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const experiment = await copySmallExperiment(root, "retry-storm.experiment.json", "5ms");
      experiment.faults = [];
      experiment.variants = [{ id: "baseline", label: "Baseline" }];
      const modelPath = resolve(root, "retry-storm.model.json");
      const model: ModelFile = JSON.parse(await readFile(modelPath, "utf8"));
      model.blocks.gateway.params = { ...model.blocks.gateway.params, replicas: 3, handlers: 2 };
      model.blocks.gateway.replicaOverrides = { "2": { processing: { kind: "fixed", mean: "100ms" } } };
      await writeFile(modelPath, JSON.stringify(model));
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
      const completed = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true }).click();
      const runId = /\/runs\/([^/]+)\/summary$/.exec((await completed).url())![1];
      const route = `/api/v1/runs/${runId}/series/baseline/p0/0`;
      const index: SeriesIndex = await (await request.get(route)).json();
      const parts: number[] = [];
      await page.route(`**${route}/*`, async intercepted => {
        parts.push(Number(intercepted.request().url().split("/").at(-1)));
        await intercepted.continue();
      });
      await page.getByRole("tab", { name: ru ? "Таймлайн" : "Timeline", exact: true }).click();
      const utilization = page.getByRole("region", { name: ru ? "Загрузка" : "Utilization", exact: true });
      await expect(utilization.locator(".recharts-area-area")).toHaveCount(1);
      await expect(utilization.locator(".recharts-area-area")).toBeVisible();
      await expect(page.getByText(ru ? "Загрузка рядов…" : "Loading series…", { exact: true })).toBeHidden();
      expect(parts.length).toBeGreaterThan(0);
      const reference = (number: number) => index.parts.find(part => part.file === `part-${number}.json.gz`)!;
      expect(parts.every(number => reference(number).kind === "GROUP")).toBe(true);
      const before = new Set(parts);
      await page.getByText(ru ? "Элементы и показатели" : "Elements and metrics", { exact: true }).click();
      const choices = page.getByRole("group", { name: ru ? "gateway · Сервис" : "gateway · Service", exact: true });
      for (const name of ru ? ["Поступившие попытки", "Ошибки", "Средняя задержка"] : ["Offered attempts", "Failures", "Mean latency"]) {
        await choices.getByRole("checkbox", { name, exact: true }).uncheck();
      }
      await page.getByRole("checkbox", { name: ru ? "Добавить реплику #2 на график" : "Add replica #2 to chart", exact: true }).check();
      await expect(utilization.locator(".timeline-readout")).toContainText("gateway#2");
      await expect(utilization.locator(".recharts-line-curve")).toHaveCount(2);
      const added = parts.filter(number => !before.has(number));
      expect(added.length).toBeGreaterThan(0);
      expect(added.every(number => reference(number).kind === "INSTANCE" && reference(number).nodes.includes("gateway#2"))).toBe(true);
      await page.getByText(ru ? "Элементы и показатели" : "Elements and metrics", { exact: true }).click();
      await utilization.getByRole("slider").focus();
      await utilization.getByRole("slider").press("End");
      const last = Math.ceil(index.endMs / index.windowMs) - 1;
      const playback = page.getByRole("slider", { name: ru ? "Окно воспроизведения" : "Playback window", exact: true });
      await expect(playback).toHaveValue(String(last));
      await expect(utilization.locator(".timeline-replica-range")).toContainText(/\d/);
      await expect(page.getByTestId("canvas-results-gateway")).not.toHaveAttribute("aria-busy", "true");
      if (ru) {
        await page.getByRole("button", { name: "Анализ", exact: true }).click();
        await page.screenshot({ path: testInfo.outputPath("timeline-group-replica-ru.png") });
        await page.getByRole("button", { name: "Анализ", exact: true }).click();
      }
      await playback.focus();
      await playback.press("Home");
      await page.getByRole("button", { name: ru ? "Воспроизвести прогон" : "Play run", exact: true }).click();
      await expect.poll(async () => Number(await playback.inputValue())).toBeGreaterThan(0);
      await page.getByRole("button", { name: ru ? "Приостановить воспроизведение" : "Pause run", exact: true }).click();
      const paused = Number(await playback.inputValue());
      await expect(page.getByTestId("timeline-cursor")).toContainText(`${ru ? "Окно" : "Window"} ${paused} ·`);
      await expect(page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: ru ? "Отменить действие" : "Undo", exact: true })).toBeDisabled();
      expect(JSON.parse(await readFile(modelPath, "utf8"))).toEqual(model);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
