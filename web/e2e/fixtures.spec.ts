import { cleanupWorkspace, copyRetryStorm, expect, selectExperiment, test } from "./fixtures";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

test("workspace cleanup allows storage initialization and a reload without missing documents", async ({ page }) => {
  const name = `cleanup-${randomUUID()}`;
  const directory = resolve("../apps/server/build/e2e-workspace", name);
  await copyRetryStorm(directory);
  try {
    await page.addInitScript(() => localStorage.setItem("cleanup-init", "ready"));
    await page.goto("/");
    await selectExperiment(page, `${name}/retry-storm.experiment.json`);
    await expect(page.getByTestId("block-node")).toHaveCount(4);

    await cleanupWorkspace(page, directory);
    await page.reload();
    await expect(page.locator("body")).toContainText("applicationVersion");
    expect(await page.evaluate(() => localStorage.getItem("cleanup-init"))).toBe("ready");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await cleanupWorkspace(page, directory);
  }
});

test("workspace cleanup tolerates a closed page and an already removed directory", async ({ page }) => {
  const directory = resolve("../apps/server/build/e2e-workspace", `cleanup-${randomUUID()}`);
  await copyRetryStorm(directory);
  await page.close();

  await cleanupWorkspace(page, directory);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  await cleanupWorkspace(page, directory);
});
