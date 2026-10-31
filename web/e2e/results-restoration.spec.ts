import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ locale: "ru-RU", viewport: { width: 1440, height: 900 } });

test("restores completed Findings and diagram results after reload and reopening, marking saved edits stale", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/results-restoration");
  const experimentPath = "results-restoration/retry-storm.experiment.json";
  await mkdir(directory);
  let submissions = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/jobs") submissions += 1;
  });
  try {
    await copySmallExperiment(directory);
    await page.goto("/");
    await selectExperiment(page, experimentPath);
    await page.getByRole("button", { name: "Запустить", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
    const findings = page.getByRole("table", { name: "Выводы", exact: true });
    await expect(findings).toBeVisible();
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    const metrics = page.getByTestId("canvas-results-gateway");
    const original = await metrics.textContent();
    expect(original).toBeTruthy();

    await page.reload();
    await expect(page.getByRole("tabpanel")).toBeHidden();
    await page.getByRole("tab", { name: "Выводы", exact: true }).click();
    await expect(findings).toBeVisible();
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await expect(metrics).toHaveText(original!);
    const stale = page.getByText("Результаты относятся к предыдущей версии документов.", { exact: true });
    await expect(stale).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.mouse.move(800, 570);
    await page.screenshot({ path: testInfo.outputPath("restored-results-ru.png") });

    await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
    await selectExperiment(page, experimentPath);
    await page.getByRole("tab", { name: "Выводы", exact: true }).click();
    await expect(findings).toBeVisible();
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await expect(metrics).toHaveText(original!);

    await page.getByRole("tab", { name: "Модель", exact: true }).click();
    const parameter = page.getByTestId("canvas-param-gateway-handlers");
    await parameter.dblclick();
    await parameter.locator("input").fill("7");
    await parameter.locator("input").press("Enter");
    const save = page.getByRole("button", { name: "Сохранить", exact: true });
    await save.click();
    await expect(save).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("tabpanel")).toBeHidden();
    await page.getByRole("tab", { name: "Выводы", exact: true }).click();
    await expect(findings).toBeVisible();
    await expect(stale.first()).toBeVisible();
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await expect(metrics).toHaveText(original!);
    await expect(parameter).toHaveText("7");
    await expect(save).toBeDisabled();
    expect(submissions).toBe(1);
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.mouse.move(800, 570);
    await page.screenshot({ path: testInfo.outputPath("restored-stale-results-ru.png") });
  } finally {
    await rm(directory, { recursive: true });
  }
});
