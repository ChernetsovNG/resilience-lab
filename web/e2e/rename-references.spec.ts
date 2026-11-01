import { expect, selectExperiment, test, removeWorkspacePath } from "./fixtures";
import { randomUUID } from "node:crypto";
import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile } from "../src/api/apiTypes";

test.use({ locale: "ru-RU", viewport: { width: 1440, height: 900 }, actionTimeout: 10_000 });

test("saves checkout block and automatic link renames into checkout-grid before validating and estimating it", async ({ page }, testInfo) => {
  const directory = `rename-references-${randomUUID()}`;
  const root = resolve("../apps/server/build/e2e-workspace", directory);
  await cp(resolve("../examples/checkout"), root, { recursive: true });
  try {
    await page.goto("/");
    await selectExperiment(page, `${directory}/checkout.experiment.json`);
    const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });
    for (const [id, next] of [["payment-service", "payments"], ["psp", "provider"]]) {
      await page.getByTestId(`rf__node-${id}`).locator(".block-node > strong").click();
      await expect(inspector.getByText("Ссылки обновятся также в: checkout-grid", { exact: true })).toBeVisible();
      if (id === "payment-service") {
        await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
        await page.mouse.move(700, 70);
        await page.screenshot({ path: testInfo.outputPath("related-experiments-ru.png") });
      }
      const identifier = inspector.getByRole("textbox", { name: "Идентификатор", exact: true });
      await identifier.fill(next);
      await identifier.press("Enter");
      await expect(page.getByTestId(`rf__node-${next}`)).toBeVisible();
    }
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByText("Несохранённые изменения", { exact: true })).toBeHidden();
    const gridPath = `${directory}/checkout-grid.experiment.json`;
    const stored = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(gridPath)}`);
    const experiment: ExperimentFile = (await stored.json()).content.experiment;
    expect(experiment.grid!.map(axis => axis.path)).toEqual(["order-service-to-payments.timeout", "order-service-to-payments.attempts"]);
    expect(experiment.faults[0].target).toBe("provider");
    await selectExperiment(page, gridPath);
    await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Параметр оси 1", exact: true })).toHaveValue("order-service-to-payments.timeout");
    await expect(page.getByRole("combobox", { name: "Параметр оси 2", exact: true })).toHaveValue("order-service-to-payments.attempts");
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.getByRole("tab", { name: /^Проблемы/ }).click();
    await expect(page.locator(".validation-problems .diagnostic--error")).toHaveCount(0);
    const estimate = page.waitForResponse(response => response.url().endsWith("/estimate") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Оценка", exact: true }).click();
    const response = await estimate;
    expect(response.ok()).toBe(true);
    expect((await response.json()).tasks).toBeGreaterThan(0);
  } finally { await removeWorkspacePath(page, root); }
});
