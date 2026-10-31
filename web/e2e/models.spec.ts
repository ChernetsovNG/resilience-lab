import { expect, test } from "./fixtures";
import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 10_000 });

test("checkout opens its main experiment and remembers a dismissible information overlay in Russian", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
  await page.goto("/");
  await page.getByLabel("Модель", { exact: true }).selectOption("checkout/checkout.model.json");
  await expect(page.getByLabel("Эксперимент", { exact: true })).toHaveValue("checkout/checkout.experiment.json");
  const about = page.getByRole("button", { name: "О модели", exact: true });
  const panel = page.getByRole("dialog", { name: "О модели", exact: true });
  const canvas = page.getByRole("application", { name: "Полотно модели", exact: true });
  await expect(panel).toContainText("Оформление заказа");
  await expect(panel.getByRole("heading", { name: "Модель", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Эксперимент", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  await expect(page.locator(".inspector-annotations")).not.toHaveAttribute("open");
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    if (!await panel.isVisible()) await about.click();
    await expect(panel).toBeInViewport({ ratio: 1 });
    const size = (await canvas.boundingBox())!;
    await page.screenshot({ path: testInfo.outputPath(`checkout-about-open-ru-${viewport.width}.png`) });
    await page.getByRole("button", { name: "Закрыть сведения о модели", exact: true }).click();
    await expect(panel).toBeHidden();
    expect(await canvas.boundingBox()).toEqual(size);
    await expect(about).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`checkout-about-closed-ru-${viewport.width}.png`) });
  }
  await page.getByTestId("rf__node-api-gateway").locator(".block-node-header").click();
  await page.getByRole("button", { name: "Свернуть инспектор", exact: true }).click();
  await about.click();
  await page.getByRole("button", { name: "Полные заметки", exact: true }).click();
  await expect(panel).toBeHidden();
  const annotations = page.locator(".inspector-annotations");
  await expect(annotations).toHaveAttribute("open");
  await expect(annotations.getByRole("group", { name: "Модель", exact: true }).getByRole("textbox", { name: "Заметки", exact: true })).toBeFocused();
  await expect(annotations.getByRole("group", { name: "Эксперимент", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Отменить действие", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("checkout-notes-ru.png") });
  await page.reload();
  await expect(about).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  await page.getByLabel("Модель", { exact: true }).selectOption("retry-storm/retry-storm.model.json");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.getByLabel("Модель", { exact: true }).selectOption("checkout/checkout.model.json");
  await expect(about).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await about.click();
  const banner = (await page.getByTestId("variant-banner").boundingBox())!;
  expect((await about.boundingBox())!.y).toBeGreaterThanOrEqual(banner.y + banner.height);
  await page.locator(".react-flow__pane").click({ position: { x: 600, y: 100 } });
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Отменить действие", exact: true })).toBeDisabled();
});

test("long model information scrolls within the canvas and keeps full notes reachable", async ({ page }) => {
  const directory = `model-info-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  await cp(resolve("../examples/retry-storm"), target, { recursive: true });
  try {
    const path = resolve(target, "retry-storm.model.json");
    const model = JSON.parse(await readFile(path, "utf8"));
    model.description = "A long explanation of the model and its assumptions. ".repeat(300);
    await writeFile(path, JSON.stringify(model));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByLabel("Model", { exact: true }).selectOption(`${directory}/retry-storm.model.json`);
    const panel = page.getByRole("dialog", { name: "About model", exact: true });
    await expect(panel).toBeVisible();
    const canvas = (await page.getByRole("application", { name: "Model canvas", exact: true }).boundingBox())!;
    const box = (await panel.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height);
    expect(await panel.locator(".model-info-copy").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const notes = panel.getByRole("button", { name: "Full notes", exact: true });
    await expect(notes).toBeInViewport({ ratio: 1 });
    await notes.click();
    await expect(page.locator(".inspector-annotations")).toHaveAttribute("open");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  } finally { await rm(target, { recursive: true, force: true }); }
});

test("checkout keeps its diagram while switching its two questions and remembers the last one", async ({ page }, testInfo) => {
  await page.goto("/");
  const model = page.getByLabel("Model", { exact: true });
  const experiment = page.getByLabel("Experiment", { exact: true });
  await model.selectOption("checkout/checkout.model.json");
  await expect(experiment.locator('option[value$=".experiment.json"]')).toHaveCount(2);
  await experiment.selectOption("checkout/checkout.experiment.json");
  await expect(experiment).toHaveAttribute("title", "checkout/checkout.experiment.json");
  let diagram: string[] = [];
  // The canvas remounts on document changes: validate and capture the same DOM read.
  await expect.poll(async () => {
    diagram = await page.getByTestId("block-node").allTextContents();
    return diagram;
  }).toHaveLength(5);
  await experiment.selectOption("checkout/checkout-grid.experiment.json");
  await expect.poll(() => page.getByTestId("block-node").allTextContents()).toEqual(diagram);
  await expect(model).toHaveValue("checkout/checkout.model.json");
  await page.screenshot({ path: testInfo.outputPath("model-experiments.png") });
  await model.selectOption("retry-storm/retry-storm.model.json");
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await model.selectOption("checkout/checkout.model.json");
  await expect(experiment).toHaveValue("checkout/checkout-grid.experiment.json");
  await page.reload();
  await expect(model).toHaveValue("checkout/checkout.model.json");
  await expect(experiment).toHaveValue("checkout/checkout-grid.experiment.json");
});

test("a model without experiment or layout creates its baseline on the first Run", async ({ page }) => {
  const directory = `model-only-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  await mkdir(target);
  try {
    await copyFile(resolve("../examples/retry-storm/retry-storm.model.json"), resolve(target, "system.model.json"));
    await page.goto("/");
    await page.getByLabel("Model", { exact: true }).selectOption(`${directory}/system.model.json`);
    await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(`${directory}/system.experiment.json`);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    expect(await readdir(target)).toEqual(["system.model.json"]);
    const submitted = page.waitForResponse(response => response.url().endsWith("/api/v1/jobs") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const submission = await submitted;
    expect(submission.ok()).toBe(true);
    const job = await submission.json();
    await expect.poll(async () => (await (await page.request.get(`/api/v1/jobs/${job.id}`)).json()).status).toBe("RUNNING");
    const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/system.experiment.json`)}`);
    expect(response.ok()).toBe(true);
    expect((await response.json()).content.experiment).toMatchObject({
      modelRef: "system.model.json", execution: { warmup: "10s", measurement: "60s", replications: 10 }, variants: [{ id: "baseline" }],
    });
    expect((await readdir(target)).sort()).toEqual(["system.experiment.json", "system.model.json"]);
    const cancelled = await page.request.post(`/api/v1/jobs/${job.id}/cancel`);
    expect(cancelled.ok()).toBe(true);
    await expect(page.getByTestId("job-status")).toHaveText(/^CANCELLED\b/);
  } finally { await rm(target, { recursive: true, force: true }); }
});

test("deleting the only experiment keeps the model open with an in-memory default", async ({ page }) => {
  const directory = `model-delete-question-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  await cp(resolve("../examples/retry-storm"), target, { recursive: true });
  try {
    await page.goto("/");
    const modelPath = `${directory}/retry-storm.model.json`;
    const experimentPath = `${directory}/retry-storm.experiment.json`;
    await page.getByLabel("Model", { exact: true }).selectOption(modelPath);
    await expect(page.getByTestId("block-node")).toHaveCount(4);
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("button", { name: "Delete experiment…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete experiment…", exact: true });
    await expect(dialog.getByRole("listitem")).toHaveText([experimentPath]);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(modelPath);
    await expect(page.getByTestId("block-node")).toHaveCount(4);
    await expect(page.getByLabel("Replications", { exact: true })).toHaveValue("10");
    const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(experimentPath)}`);
    expect(response.status()).toBe(404);
    expect((await readdir(target)).sort()).toEqual(["retry-storm.layout.json", "retry-storm.model.json"]);
    await page.getByRole("button", { name: "File", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete experiment…", exact: true })).toBeDisabled();
  } finally { await rm(target, { recursive: true, force: true }); }
});
