import { selectExperiment } from "./fixtures";
import { expect, test } from "./fixtures";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { JobView, RunSummary } from "../src/api/apiTypes";

const experiments = ["checkout/checkout.experiment.json", "checkout/checkout-grid.experiment.json"];

test.use({ viewport: { width: 1440, height: 900 } });

for (const experiment of experiments) {
  test(`${experiment} opens and validates without running the full experiment`, async ({ page, request }) => {
    await page.goto("/");
    await page.getByLabel("Model", { exact: true }).selectOption("checkout/checkout.model.json");
    const selector = page.getByLabel("Experiment", { exact: true });
    await expect(selector.locator(`option[value="${experiment}"]`)).toHaveText(experiment.replace(/\.experiment\.json$/, ""));
    await selector.selectOption(experiment);
    await expect(page.getByTestId("block-node")).toHaveCount(5);
    for (const node of ["mobile-app", "api-gateway", "order-service", "payment-service", "psp"]) {
      await expect(page.getByTestId(`rf__node-${node}`)).toBeInViewport({ ratio: 0.99 });
    }
    const response = await request.post("/api/v1/validate", { data: { experiment } });
    expect(response.ok()).toBe(true);
    const report = await response.json();
    expect(report.valid).toBe(true);
    expect(report.diagnostics.filter((diagnostic: { severity: string }) => diagnostic.severity === "ERROR")).toEqual([]);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });
}

test("opens Problems from a collapsed example and restores each tab's saved height", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("resilience-lab.results-panel-heights", JSON.stringify({
    "normal:answer": 200, "normal:problems": 320,
  })));
  await page.goto("/");
  await selectExperiment(page, "checkout/checkout-grid.experiment.json");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toBeHidden();

  const problems = page.getByRole("tab", { name: "Problems", exact: true });
  await problems.click();
  await expect(problems).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".validation-problems").getByRole("listitem").first()).toBeVisible();
  const divider = page.getByRole("separator", { name: "Resize results panel" });
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
  await problems.click();
  await expect(panel).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "320");

  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await page.getByRole("tab", { name: "Findings", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "200");
  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await problems.click();
  await expect(panel).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
});

test.describe("readable checkout answer", () => {
  test.use({ locale: "ru-RU", viewport: { width: 1280, height: 800 } });

  test("compares variants and relates recorded saturation to the PSP fault", async ({ page }, testInfo) => {
    await page.goto("/");
    await selectExperiment(page, "checkout/checkout.experiment.json");
    const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Запустить", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    await expect(page.getByRole("table", { name: "Выводы", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await page.getByRole("button", { name: "Анализ", exact: true }).click();
    const overview = page.getByRole("region", { name: "Сводка по вариантам" });
    const best = [...summary.variants].sort((left, right) =>
      right.points[0].aggregate.entries.total.successRate!.mean - left.points[0].aggregate.entries.total.successRate!.mean)[0];
    expect(best.id).toBe("bigger-payment-pool");
    await expect(overview.getByTestId("comparison-conclusion")).toContainText("Лучшая наблюдаемая доля успешных запросов: Bigger payment pool");
    await expect(overview.getByTestId("comparison-conclusion")).toContainText("Наименьший наблюдаемый p99:");
    const table = page.getByRole("table", { name: "Выводы", exact: true });
    await expect(page.getByText("По клиентам", { exact: true })).toHaveCount(0);
    await expect(page.getByText("По видам запросов", { exact: true })).toHaveCount(0);
    await expect(table.getByRole("rowheader", { name: "Причины отказа", exact: true })).toHaveCount(0);
    await expect(table.getByRole("rowheader", { name: "Успешные с заглушкой", exact: true })).toHaveCount(0);
    for (const variant of summary.variants) await expect(table.getByRole("columnheader", { name: new RegExp(variant.label) })).toBeVisible();
    await expect(table.getByRole("row", { name: /p99/ }).getByRole("cell").first()).toContainText("совпадает с таймаутом 5 с");
    const first = summary.variants[0].points[0].saturation.firstNodes[0];
    expect(first.medianStartMs).toBeGreaterThanOrEqual(20000);
    expect(first.medianStartMs).toBeLessThan(40000);
    const insight = page.getByRole("region", { name: "Вывод о насыщении" });
    await expect(insight).toContainText("во время отказа psp");
    await expect(insight).toContainText("20–40 с");
    expect(((await page.getByRole("tabpanel").innerText()).match(/по объединённым данным/g) ?? []).length).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("checkout-answer.png") });
    await page.setViewportSize({ width: 1440, height: 1200 });
    await table.screenshot({ path: testInfo.outputPath("checkout-quantiles-ru.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("tab", { name: "Таймлайн", exact: true }).click();
    await expect(page.locator(".timeline-axis").first()).toHaveText("Время симуляции (с)");
    await expect(page.locator(".timeline-chart").first().getByText("70", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("checkout-timeline.png") });
  });

  test("shows pooled headroom and one path for a run without faults", async ({ page }, testInfo) => {
    const file = "../apps/server/build/e2e-workspace/checkout/no-faults.experiment.json";
    const experiment = JSON.parse(await readFile("../examples/checkout/checkout.experiment.json", "utf8"));
    experiment.faults = [];
    await writeFile(file, JSON.stringify(experiment));
    try {
      await page.goto("/");
      await selectExperiment(page, "checkout/no-faults.experiment.json");
      const submitted: Promise<JobView> = page.waitForResponse(response =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/jobs",
      { timeout: testInfo.timeout }).then(response => response.json());
      const completed = page.waitForResponse(async response => {
        const path = new URL(response.url()).pathname;
        return /\/runs\/[^/]+\/summary$/.test(path) && path === `/api/v1/runs/${(await submitted).runId}/summary`;
      }, { timeout: testInfo.timeout });
      const [, , summary] = await Promise.all([
        page.getByRole("button", { name: "Запустить", exact: true }).click(), submitted, completed,
      ]);
      expect(summary.ok()).toBe(true);
      await expect(page.getByRole("table", { name: "Выводы", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      await page.getByRole("button", { name: "Анализ", exact: true }).click();
      const insight = page.getByRole("region", { name: "Вывод о насыщении" });
      await expect(insight).toContainText("по объединённым данным");
      expect((await insight.innerText()).match(/по объединённым данным/g)).toHaveLength(1);
      await expect(insight).not.toContainText("во время отказа");
      await insight.getByText("Пути деградации", { exact: true }).click();
      await expect(insight.getByRole("listitem")).toHaveText(["нет насыщения — 10 из 10 повторений"]);
      await expect(page.getByRole("table", { name: "Выводы", exact: true }).getByRole("caption")).toContainText("средние квантилей отдельных повторений");
      await page.screenshot({ path: testInfo.outputPath("checkout-headroom.png") });
    } finally { await rm(file, { force: true }); }
  });
});


test.describe("grid Findings in Russian", () => {
  test.use({ locale: "ru-RU" });

  test("labels the summary and saturation with the selected checkout grid point", async ({ page }, testInfo) => {
    await page.goto("/");
    await selectExperiment(page, "checkout/checkout-grid.experiment.json");
    const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Запустить", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    expect(summary.variants[0].points).toHaveLength(9);
    await expect(page.getByRole("table", { name: "Выводы", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    const points = page.getByLabel("Точка сетки", { exact: true });
    for (const [point, timeout, attempts] of [["p0", "1 с", "1"], ["p8", "5 с", "3"]]) {
      await points.selectOption(point);
      for (const name of ["Сводка по вариантам", "Вывод о насыщении"]) {
        const heading = page.getByRole("region", { name, exact: true }).getByRole("heading");
        await expect(heading).toContainText(`Таймаут · order-service → payment-service = ${timeout}`);
        await expect(heading).toContainText(`Попытки · order-service → payment-service = ${attempts}`);
        await expect(heading).not.toContainText(point);
      }
    }
    await page.getByRole("button", { name: "Анализ", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("checkout-grid-findings-ru.png") });
    await expect(page.getByText("По клиентам", { exact: true })).toHaveCount(0);
    await expect(page.getByText("По видам запросов", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Карта", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Вход", exact: true })).toHaveCount(0);
  });
});
