import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test("reload asks before losing edits and stops asking after Save", async ({ page }) => {
  const directory = `unsaved-reload-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  await mkdir(target);
  try {
    await copySmallExperiment(target);
    const path = `${directory}/retry-storm.experiment.json`;
    await page.goto("/");
    await selectExperiment(page, path);
    const replications = page.getByLabel("Replications", { exact: true });
    await replications.click();
    await replications.fill("3");
    // Both component-local text and committed document edits must survive a cancelled reload.
    for (const committed of [false, true]) {
      if (committed) await replications.press("Tab");
      await expect(page.getByRole("button", { name: "Run", exact: true }))
        .toHaveAttribute("title", "Saves changes before running (Ctrl/Cmd+Enter)");
      const prompted = page.waitForEvent("dialog");
      // A cancelled navigation never reaches the load event awaited by page.reload().
      const reload = page.evaluate(() => window.location.reload());
      const dialog = await prompted;
      expect(dialog.type()).toBe("beforeunload");
      await dialog.dismiss();
      await reload;
      await expect(replications).toHaveValue("3");
    }
    await expect(page.locator(".dirty-mark")).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".dirty-mark")).toBeHidden();
    const prompts: string[] = [];
    page.on("dialog", async next => { prompts.push(next.type()); await next.dismiss(); });
    await page.reload();
    await expect(replications).toHaveValue("3");
    expect(prompts).toEqual([]);
  } finally { await rm(target, { recursive: true, force: true }); }
});

test.describe("Russian unsaved changes", () => {
  test.use({ locale: "ru-RU", viewport: { width: 1280, height: 800 } });

  test("Save and switch writes the current documents before opening another model", async ({ page }, testInfo) => {
    const directory = `unsaved-switch-${randomUUID()}`;
    const target = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(target);
    try {
      await copySmallExperiment(target);
      const path = `${directory}/retry-storm.experiment.json`;
      const modelPath = `${directory}/retry-storm.model.json`;
      await page.goto("/");
      await selectExperiment(page, path);
      await page.getByTestId("rf__node-gateway").click();
      const handlers = page.getByLabel("Обработчики", { exact: true });
      await handlers.fill("7");
      await handlers.press("Tab");
      await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
      const replications = page.getByLabel("Повторения", { exact: true });
      await replications.fill("3");
      await replications.press("Tab");
      await expect(page.getByRole("button", { name: "Запустить", exact: true }))
        .toHaveAttribute("title", "Сохраняет изменения перед запуском (Ctrl/Cmd+Enter)");
      await page.getByLabel("Модель", { exact: true }).selectOption("checkout/checkout.model.json");
      const dialog = page.getByRole("dialog", { name: "Несохранённые изменения", exact: true });
      await expect(dialog.getByRole("button", { name: "Не сохранять", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Отмена", exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("unsaved-switch-ru-1280.png") });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: testInfo.outputPath("unsaved-switch-ru-1440.png") });
      await dialog.getByRole("button", { name: "Сохранить и перейти", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByLabel("Модель", { exact: true })).toHaveValue("checkout/checkout.model.json");
      const modelResponse = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`);
      expect(modelResponse.ok()).toBe(true);
      expect((await modelResponse.json()).content.model.blocks.gateway.params.handlers).toBe(7);
      const experimentResponse = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
      expect(experimentResponse.ok()).toBe(true);
      expect((await experimentResponse.json()).content.experiment.execution.replications).toBe(3);
      await selectExperiment(page, path);
      await expect(replications).toHaveValue("3");
      await expect(page.locator(".dirty-mark")).toBeHidden();
      await page.getByTestId("rf__node-gateway").click();
      await expect(handlers).toHaveValue("7");
    } finally { await rm(target, { recursive: true, force: true }); }
  });
});
