import { expect, test } from "@playwright/test";
import { selectExperiment } from "./fixtures";

for (const language of ["en", "ru"] as const) {
  test(`checkout-grid explains shared sweep cost and variant warnings in ${language}`, async ({ page }, testInfo) => {
    const russian = language === "ru";
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    await page.goto("/");
    await selectExperiment(page, "checkout/checkout-grid.experiment.json");
    const settings = page.getByRole("button", { name: russian ? "Настройки прогона" : "Run settings", exact: true });
    const inspector = page.getByRole("complementary", { name: russian ? "Инспектор" : "Inspector", exact: true });
    await settings.click();
    const cost = inspector.getByLabel(russian ? "Размер перебора" : "Sweep size", { exact: true });
    await expect(cost).toHaveText(russian
      ? "3 × 3 = 9 точек × 1 вариант × 10 повторений = 90 прогонов"
      : "3 × 3 = 9 points × 1 variant × 10 replications = 90 runs");
    await page.getByRole("button", { name: russian ? "Добавить вариант" : "Add variant", exact: true }).click();
    const name = inspector.getByLabel(russian ? "Название варианта" : "Variant label", { exact: true });
    await name.fill("hello");
    await name.press("Enter");
    await settings.click();
    await expect(cost).toHaveText(russian
      ? "3 × 3 = 9 точек × 2 варианта × 10 повторений = 180 прогонов"
      : "3 × 3 = 9 points × 2 variants × 10 replications = 180 runs");
    const axis = inspector.getByRole("group", { name: `${russian ? "Таймаут" : "Timeout"} · order-service → payment-service`, exact: true });
    const warning = axis.locator(".field-diagnostics > li").filter({ hasText: "LINT_TIMEOUT_BUDGET" })
      .filter({ hasText: russian ? /Таймаут.*= 1s/ : /Timeout.*= 1s/ });
    await expect(warning).toHaveCount(1);
    await expect(warning).toContainText("Baseline, hello");
    await expect(warning).not.toContainText(/p[0-9]/);
    await axis.locator(":scope > .field-feedback").last().getByRole("button").press("Enter");
    await expect(warning).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`parameter-sweep-${language}.png`) });

    await page.getByTestId("canvas-edge-label-order-service-to-payment-service").click();
    const timeout = inspector.getByRole("textbox", { name: russian ? "Таймаут" : "Timeout", exact: true });
    await expect(timeout).toBeVisible();
    await expect(timeout.locator("..")).toContainText(russian ? "Значение задаётся перебором параметров" : "Swept by the parameter grid");
  });
}
