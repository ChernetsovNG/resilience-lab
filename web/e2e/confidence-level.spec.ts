import { expect, test } from "@playwright/test";
import type { RunSummary } from "../src/api/apiTypes";

test.use({ viewport: { width: 1280, height: 720 } });

test("confidence updates retry-storm success intervals without another run and survives reload", async ({ page, request }, testInfo) => {
  let jobs = 0;
  page.on("request", request => {
    if (request.url().endsWith("/api/v1/jobs") && request.method() === "POST") jobs += 1;
  });
  await page.goto("/");
  await page.getByLabel("Experiment", { exact: true }).selectOption("retry-storm/retry-storm.experiment.json");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const summaryResponse = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const response = await summaryResponse;
  const summary = await response.json() as RunSummary;
  const baseline = summary.variants.find(variant => variant.id === "baseline")!;
  const metric = baseline.points[0].aggregate.successRate!;
  expect(baseline.replications).toBe(10);
  expect(metric.count).toBe(10);
  const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
  const success = page.getByRole("table", { name: "Answer", exact: true })
    .getByRole("row", { name: /Success rate/ }).locator("td").first();
  const interval = success.locator(".summary-interval");
  await expect(interval).toContainText(`95% CI ${percent.format(metric.ci95Low!)}–${percent.format(metric.ci95High!)}`);
  const before = await interval.textContent();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByLabel("Confidence level", { exact: true }).selectOption("99");
  await page.getByRole("button", { name: "View", exact: true }).click();
  // Independent reference: t(0.995, 9), not the web calculator under test.
  const radius = 3.2498355415921254 * metric.stdDev! / Math.sqrt(metric.count);
  await expect(interval).toContainText(`99% CI ${percent.format(metric.mean - radius)}–${percent.format(metric.mean + radius)}`);
  await expect(interval).not.toHaveText(before!);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  expect(await (await request.get(response.url())).json()).toEqual(summary);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByLabel("Language", { exact: true }).selectOption("ru");
  await expect(page.getByLabel("Уровень доверия", { exact: true })).toHaveValue("99");
  const menu = (await page.locator(".view-menu-panel").boundingBox())!;
  const button = (await page.getByRole("button", { name: "Вид", exact: true }).boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(button.y + button.height);
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(1280);
  expect(menu.y + menu.height).toBeLessThanOrEqual(720);
  await page.screenshot({ path: testInfo.outputPath("view-menu-ru-1280x720.png") });
  await page.getByLabel("Уровень доверия", { exact: true }).selectOption("90");
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await expect(page.getByRole("table", { name: "Ответ", exact: true }).getByRole("row", { name: /Доля успешных/ })
    .locator("td").first()).toContainText(/90\s*% CI/);
  expect(jobs).toBe(1);

  await page.reload();
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await expect(page.getByLabel("Уровень доверия", { exact: true })).toHaveValue("90");
  expect(jobs).toBe(1);
});
