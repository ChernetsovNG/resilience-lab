import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupWorkspace, copySmallExperiment, expect, selectExperiment, test } from "./fixtures";
import { dragCanvas, waitForStableRects } from "./canvasGestures";
import ru from "../src/i18n/ru.json" with { type: "json" };

test.use({ viewport: { width: 1440, height: 900 } });

test("expanded results select an element through the backend results while playback continues", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/expanded-results");
  await mkdir(directory);
  try {
    const experiment = await copySmallExperiment(directory, "retry-storm.experiment.json", "3ms");
    experiment.variants = ["Базовый", "Короткие таймауты", "Без повторов", "Ограниченные повторы", "Длинный таймаут"].map((label, index) => ({
      ...structuredClone(experiment.variants[0]), id: index === 0 ? "baseline" : `comparison-${index}`, label,
    }));
    await writeFile(resolve(directory, "retry-storm.experiment.json"), JSON.stringify(experiment));
    await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
    await page.goto("/");
    await selectExperiment(page, "expanded-results/retry-storm.experiment.json");
    await page.locator("#variant-baseline").click();
    await page.getByRole("button", { name: ru["app.topBar.run"], exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText(ru["app.job.status.COMPLETED"]);
    const divider = page.getByRole("separator", { name: ru["results.resize.label"], exact: true });
    await divider.press("Home");
    await waitForStableRects(divider);
    const initialHeight = (await page.locator(".results-panel").boundingBox())!.height;
    const context = page.locator(".results-context-bar");
    await context.getByRole("button", { name: ru["results.context.time"], exact: true }).click();
    const cursor = context.getByRole("slider", { name: ru["results.playback.window"], exact: true, includeHidden: true });
    await expect(cursor).toHaveValue("0");
    await context.getByRole("button", { name: ru["results.playback.play"], exact: true }).click();
    const startingWindow = Number(await cursor.inputValue());
    await page.getByRole("button", { name: ru["results.expand"], exact: true }).click();
    const strip = page.getByRole("region", { name: ru["results.diagram.collapsed"], exact: true });
    await expect(strip).toBeVisible();
    await expect(page.locator(".canvas-area")).toBeHidden();
    await expect.poll(async () => Number(await cursor.inputValue())).toBeGreaterThan(startingWindow);
    const playedWindow = Number(await cursor.inputValue());
    const inspectorDivider = page.getByRole("separator", { name: ru["editor.inspector.resize"], exact: true });
    await inspectorDivider.press("End");
    expect((await page.locator(".inspector-panel").boundingBox())!.width).toBe(720);
    await dragCanvas(inspectorDivider, page.locator(".workspace-panels"), {
      targetPosition: (source, target) => ({ x: source.x + source.width / 2 + 240 - target.x, y: source.y + source.height / 2 - target.y }),
    });
    expect((await page.locator(".inspector-panel").boundingBox())!.width).toBe(480);
    await page.getByRole("button", { name: ru["editor.inspector.collapse"], exact: true }).click();
    const service = ru["results.answer.serviceMetrics"].replace("{service}", "dependency");
    await page.locator(".summary-services > summary").filter({ hasText: service }).click();
    await expect(page.locator(".workspace-panels--expanded")).toBeVisible();
    await expect(strip).toContainText(ru["results.diagram.selection"].replace("{selection}", "dependency"));
    await expect(page.locator(".inspector-content")).toBeVisible();
    await expect(page.locator(".inspector")).toContainText("dependency");
    await expect(page.locator(".canvas-area")).toBeHidden();
    const body = page.locator(".results-body");
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)).toBe(true);
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; element.scrollLeft = element.scrollWidth; });
    expect(await page.evaluate(() => ({ top: document.scrollingElement!.scrollTop,
      height: document.scrollingElement!.scrollHeight, viewport: innerHeight }))).toEqual({ top: 0, height: 900, viewport: 900 });
    await body.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
    await page.screenshot({ path: testInfo.outputPath("expanded-results-ru.png") });
    await strip.getByRole("button", { name: ru["results.diagram.showSelection"], exact: true }).click();
    await expect(page.locator(".canvas-area")).toBeVisible();
    await expect(page.getByTestId("rf__node-dependency")).toHaveClass(/selected/);
    expect(Number(await cursor.inputValue())).toBeGreaterThanOrEqual(playedWindow);
    await context.getByRole("button", { name: ru["results.playback.pause"], exact: true }).click();
    await waitForStableRects(divider);
    expect((await page.locator(".results-panel").boundingBox())!.height).toBe(initialHeight);
    await page.screenshot({ path: testInfo.outputPath("restored-diagram-ru.png") });
  } finally {
    await cleanupWorkspace(page, directory);
  }
});
