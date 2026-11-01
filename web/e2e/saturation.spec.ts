import { copySmallExperiment, selectExperiment } from "./fixtures";
import { expect, test } from "./fixtures";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, LayoutFile, RunSummary } from "../src/api/apiTypes";
import { formatDuration, formatNumber } from "../src/i18n/format";

test("shows the retry-storm saturation conclusion from the real summary for each variant", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/saturation-insight");
  await mkdir(directory);
  try {
    for (const name of ["retry-storm.experiment.json", "retry-storm.model.json", "retry-storm.layout.json"]) {
      await copyFile(resolve("../examples/retry-storm", name), resolve(directory, name));
    }
    const experimentPath = resolve(directory, "retry-storm.experiment.json");
    const experiment: ExperimentFile = JSON.parse(await readFile(experimentPath, "utf8"));
    experiment.variants.push({ id: "high-capacity", label: "More handlers", overrides: {
      "gateway.handlers": 32, "middle.handlers": 32, "dependency.handlers": 32,
    } });
    await writeFile(experimentPath, JSON.stringify(experiment));
    await page.goto("/");
    await selectExperiment(page, "saturation-insight/retry-storm.experiment.json");
    const response = page.waitForResponse((response) => /\/api\/v1\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    for (const variant of summary.variants) {
      await page.getByRole("tab", { name: variant.label, exact: true }).click();
      for (const point of variant.points) {
        const first = point.saturation.firstNodes[0];

        if (summary.grid.length > 0) await page.getByLabel("Grid point", { exact: true }).selectOption(point.id);
        const insight = page.getByRole("region", { name: "Saturation insight" });
        await expect(insight.getByRole("heading")).toHaveText(variant.label);
        await expect(insight).not.toContainText(/Saturation rule:|minimumDurationMs\s*=/);
        const rule = insight.getByText("A slot set counts as saturated", { exact: false });
        await expect(rule).toBeHidden();
        await insight.getByText("How saturation is detected", { exact: true }).click();
        await expect(rule).toBeVisible();
        await expect(rule).toContainText("at or above 95%");
        await insight.getByText("How saturation is detected", { exact: true }).click();
        await insight.scrollIntoViewIfNeeded();
        await expect(insight).toBeInViewport();
        if (variant.id === "high-capacity") {
          expect(point.saturation.firstNodes).toEqual([]);
          expect(point.saturation.withoutSaturation).toBe(variant.replications);
          await expect(insight).toContainText("No saturation.");
          await expect(insight.getByText(/^Capacity headroom/)).toBeVisible();
          await expect(insight).toContainText("largest mean number of queued requests");
          await expect(insight).toContainText(`entry p99 ${formatDuration(point.aggregate.entries.total.pooledLatency.all?.p99Ms)}`);
        } else {
          expect(first).toBeDefined();
          await expect(insight).toContainText(`${first.label.message} first in ${formatNumber(first.replicationCount)} of ${formatNumber(variant.replications)} replications`);
          await expect(insight).toContainText(`median start ${formatDuration(first.medianStartMs)}`);
          await expect(insight).toContainText(`range ${formatDuration(first.minStartMs)}–${formatDuration(first.maxStartMs)}`);
          await expect(insight.getByText(/^Capacity headroom/)).toHaveCount(0);
        }
        await expect(insight).toContainText(`${formatNumber(point.saturation.withoutSaturation)} of ${formatNumber(variant.replications)} replications without saturation.`);
        await page.screenshot({ path: testInfo.outputPath(`answer-${variant.id}.png`) });
      }
    }
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }));
    expect(overflow).toEqual({ horizontal: false, vertical: false });
    await page.screenshot({ path: testInfo.outputPath("saturation-summary.png") });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test.describe("readable result navigation", () => {
  test.use({ locale: "ru-RU" });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    test(`Model points to results and saturation focuses the node at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const directory = resolve(`../apps/server/build/e2e-workspace/saturation-focus-${viewport.width}`);
      await mkdir(directory);
      try {
        const experiment = await copySmallExperiment(directory);
        experiment.execution.measurement = "1s";
        experiment.faults = experiment.faults?.map(fault => ({ ...fault, from: "100ms", to: "800ms" }));
        await writeFile(resolve(directory, "retry-storm.experiment.json"), JSON.stringify(experiment));
        const layoutPath = resolve(directory, "retry-storm.layout.json");
        const layout: LayoutFile = JSON.parse(await readFile(layoutPath, "utf8"));
        for (const position of Object.values(layout.positions)) position.x *= 4;
        await writeFile(layoutPath, JSON.stringify(layout));
        await page.goto("/");
        await selectExperiment(page, `saturation-focus-${viewport.width}/retry-storm.experiment.json`);
        const hint = page.getByRole("button", { name: "Показать результаты: Baseline", exact: true });
        await expect(hint).toHaveCount(0);
        const response = page.waitForResponse(response => /\/api\/v1\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
        await page.getByRole("button", { name: "Запустить", exact: true }).click();
        const summary: RunSummary = await (await response).json();
        await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
        await expect(hint).toBeVisible();
        await expect(page.getByText("Здесь редактируется структура. Результаты на схеме — на вкладке варианта.", { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`model-results-hint-ru-${viewport.width}.png`) });
        await hint.click();
        await expect(page.locator("#variant-baseline")).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("region", { name: "Контекст результатов", exact: true })).toBeVisible();
        await expect(hint).toHaveCount(0);

        await page.getByRole("tab", { name: "Модель", exact: true }).click();
        const first = summary.variants[0].points[0].saturation.firstNodes[0];
        expect(first).toBeDefined();
        const insight = page.getByRole("region", { name: "Вывод о насыщении", exact: true });
        await insight.getByRole("button", { name: /Первое насыщение:/ }).first().click();
        const node = page.getByTestId(`rf__node-${first.node}`);
        const zoom = () => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
        await expect(node).toHaveClass(/selected/);
        await expect.poll(zoom).toBeGreaterThanOrEqual(0.7);
        await expect(node).toBeInViewport({ ratio: 1 });
        const canvas = (await page.locator(".react-flow").boundingBox())!;
        const focused = (await node.boundingBox())!;
        expect(focused.x + focused.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0);
        await expect.poll(async () => {
          const target = (await node.boundingBox())!;
          const banner = (await page.getByTestId("variant-banner").boundingBox())!;
          const course = await page.locator(".course-expanded").boundingBox();
          return Math.abs(target.y + target.height / 2 - (canvas.y + (banner.height + 16 + canvas.height - (course?.height ?? 0)) / 2));
        }).toBeLessThan(1);
        await page.screenshot({ path: testInfo.outputPath(`saturation-focus-ru-${viewport.width}.png`) });

        await page.getByRole("tab", { name: "Модель", exact: true }).click();
        await insight.getByText("Пути деградации", { exact: true }).click();
        await insight.locator("li button.result-element-link").first().click();
        await expect(page.locator("#variant-baseline")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
        await expect.poll(zoom).toBeGreaterThanOrEqual(0.7);
        await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Отменить действие", exact: true })).toBeDisabled();
      } finally {
        await rm(directory, { recursive: true });
      }
    });
  }
});
