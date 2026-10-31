import { expect, test } from "./fixtures";
import { selectExperiment } from "./fixtures";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test.use({ locale: "ru-RU", viewport: { width: 1280, height: 800 }, actionTimeout: 10_000 });

test("runs a Cyrillic model built from the palette", async ({ page }, testInfo) => {
  const name = "Платёжный контур";
  const path = name + "/" + name + ".experiment.json";
  try {
    await page.goto("/");
    await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
    await expect(page.getByTestId("block-node")).toHaveCount(4);
    await page.getByRole("button", { name: "Файл", exact: true }).click();
    await page.getByRole("button", { name: "Новая модель", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Новая модель", exact: true });
    await dialog.getByLabel("Имя модели").fill(name);
    await dialog.getByRole("button", { name: "Новая модель", exact: true }).click();
    await expect(page.getByLabel("Эксперимент", { exact: true })).toHaveValue(path);
    const palette = page.getByRole("complementary", { name: "Палитра" });
    await palette.getByRole("button", { name: "Клиент", exact: true }).dblclick();
    await palette.getByRole("button", { name: "Сервис", exact: true }).dblclick();
    await page.locator(".react-flow__controls-fitview").click();
    await page.getByTestId("rf__node-client-1").locator('[data-handleid="out"]').dragTo(
      page.getByTestId("rf__node-service-1").locator('[data-handleid="in"]'));
    await expect(page.getByTestId("rf__edge-client-1-to-service-1")).toBeAttached();
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    const run = page.getByRole("button", { name: "Запустить", exact: true });
    await expect(run).toBeEnabled();
    const file = resolve("../apps/server/build/e2e-workspace", path);
    const experiment = JSON.parse(await readFile(file, "utf8"));
    experiment.execution = { ...experiment.execution, warmup: "0ms", measurement: "300ms", replications: 2, window: "50ms" };
    await writeFile(file, JSON.stringify(experiment));
    await page.reload();
    await expect(run).toBeEnabled();
    await run.click();
    const status = page.getByTestId("job-status");
    await expect(status).toHaveText(/^(ЗАВЕРШЕНО|ОШИБКА)$/);
    await page.screenshot({ path: testInfo.outputPath("unicode-model.png") });
    await expect(status).toHaveText("ЗАВЕРШЕНО");
    const runs: { experiment: string; directory: string }[] = await (await page.request.get("/api/v1/runs")).json();
    const owned = runs.filter(run => run.experiment === path);
    expect(owned).toHaveLength(1);
    expect(owned[0].directory).toMatch(/^\.results\/[a-f0-9]{64}\/[^/]+$/);
  } finally {
    await rm(resolve("../apps/server/build/e2e-workspace", name), { recursive: true, force: true });
  }
});
