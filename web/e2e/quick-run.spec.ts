import { expect, test, removeWorkspacePath } from "./fixtures";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { copySmallExperiment, selectExperiment } from "./fixtures";

test.use({ viewport: { width: 1280, height: 800 } });

for (const language of ["en", "ru"] as const) {
  test(`saves and runs by button or keyboard, preserving the previous Findings in ${language}`, async ({ page }) => {
    await page.addInitScript(language => {
      localStorage.setItem("resilience-lab.language", language);
      localStorage.setItem("resilience-lab.results-panel-heights", JSON.stringify({ "normal:answer": 360 }));
    }, language);
    const russian = language === "ru";
    const directory = `quick-run-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await copySmallExperiment(root);
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      const run = page.getByRole("button", { name: russian ? "Запустить" : "Run", exact: true });
      const save = page.getByRole("button", { name: russian ? "Сохранить" : "Save", exact: true });
      const seed = page.getByLabel(russian ? "Начальное значение генератора" : "Seed", { exact: true });
      await expect(run).toBeEnabled();
      await seed.fill("42");
      const firstResponse = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()), { timeout: 10_000 });
      if (russian) await seed.press("ControlOrMeta+Enter");
      else await run.click();
      const first = await firstResponse;
      expect(first.ok()).toBe(true);
      const answer = page.getByRole("table", { name: russian ? "Выводы" : "Findings", exact: true });
      await expect(answer).toBeVisible();
      await expect(run).toBeEnabled();
      await expect(save).toBeDisabled();
      const stored = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.experiment.json`)}`);
      expect((await stored.json()).content.experiment.execution.seed).toBe(42);
      const firstText = await answer.innerText();

      await seed.fill("43");
      await seed.press("Enter");
      await expect(run).toBeEnabled();
      if (russian) await page.screenshot({ path: "/tmp/issue313-after-edit-run.png" });
      await page.route("**/api/v1/jobs", async route => {
        if (route.request().method() === "POST") await gate;
        await route.continue();
      });
      const secondResponse = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await seed.press("ControlOrMeta+Enter");
      const notice = russian ? "Результаты устарели, идёт новый прогон." : "Results are outdated; a new run is in progress.";
      await expect(page.getByRole("tabpanel").getByText(notice, { exact: true })).toBeVisible();
      await expect(answer).toHaveText(firstText, { useInnerText: true });
      if (russian) await page.screenshot({ path: "/tmp/issue313-after-rerun.png" });
      release();
      const second = await secondResponse;
      expect(second.ok()).toBe(true);
      expect(second.url()).not.toBe(first.url());
      await expect(run).toBeEnabled();
      await expect(page.getByTestId("job-status")).toHaveText(russian ? "ЗАВЕРШЕНО" : "COMPLETED");
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
      await expect(answer).toBeVisible();

      await seed.fill("44");
      await seed.press("ControlOrMeta+s");
      await expect(save).toBeDisabled();
      const saved = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.experiment.json`)}`);
      expect((await saved.json()).content.experiment.execution.seed).toBe(44);
    } finally { release(); await removeWorkspacePath(page, root); }
  });
}
