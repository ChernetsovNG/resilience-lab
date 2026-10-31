import { expect, test } from "./fixtures";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectExperiment } from "./fixtures";

// Exercise every supported language; #184 adds ru.json and the browser-language selection.
const locales = ["en-US", ...(existsSync(resolve("src/i18n/ru.json")) ? ["ru-RU"] : [])];

for (const locale of locales) {
  test.describe(`backend messages (${locale})`, () => {
    test.use({ locale });
    const catalog = JSON.parse(readFileSync(resolve(`src/i18n/${locale.startsWith("ru") ? "ru" : "en"}.json`), "utf8")) as Record<string, string>;
    const label = (key: string) => catalog[key];

    test("localizes linter, inspector validation and estimate warnings from the real API", async ({ page }, testInfo) => {
      await page.goto("/");
      await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
      await page.getByRole("button", { name: label("results.restore"), exact: true }).click();
      await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
      const lint = page.getByRole("tabpanel").getByRole("button", { name: /LINT_TIMEOUT_BUDGET/ });
      await expect(lint).toContainText(locale.startsWith("ru") ? /Таймаут 80 мс/ : "Timeout 80 ms");
      await expect(lint).toContainText("189");

      await page.getByRole("tab", { name: label("editor.pages.model"), exact: true }).click();
      await page.getByTestId("rf__node-gateway").click();
      const handlers = page.getByLabel(catalog["catalog.types.service.params.handlers.title"] ?? "Handlers", { exact: true });
      const original = await handlers.inputValue();
      await handlers.fill("0");
      await handlers.press("Enter");
      const validation = handlers.locator("..").locator(".field-diagnostics");
      await expect(validation).toContainText("PARAM_RANGE");
      await expect(validation).toContainText(locale.startsWith("ru") ? /[Пп]араметра? [«']Обработчики/ : "Parameter 'Handlers · gateway'");
      await handlers.locator("..").locator(".field-feedback:not(.field-feedback--variants) button").press("Enter");
      await expect(validation).toBeVisible();
      if (locale.startsWith("ru")) await page.screenshot({ path: testInfo.outputPath("russian-backend-validation.png") });
      await handlers.fill(original);
      await handlers.press("Enter");
      await expect(validation).toBeHidden();

      await page.getByRole("tab", { name: label("editor.pages.model"), exact: true }).click();
      const window = page.getByLabel(label("editor.run.seriesWindow"), { exact: true });
      await window.fill("1ms");
      await window.press("Enter");
      const measurement = page.getByLabel(label("editor.run.measurement"), { exact: true });
      await measurement.fill("1000s");
      await measurement.press("Enter");
      const estimate = page.getByRole("button", { name: label("app.estimate.label"), exact: true });
      await expect(estimate).toBeEnabled();
      await estimate.click();
      await expect(page.getByRole("region", { name: label("app.estimate.cost"), exact: true }))
        .toContainText(locale.startsWith("ru") ? /64 МиБ/ : "64 MiB UI cache budget");
    });
  });
}
