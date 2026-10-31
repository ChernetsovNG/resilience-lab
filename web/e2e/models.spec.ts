import { expect, test } from "./fixtures";
import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 10_000 });

test("checkout opens its main experiment with a visible description and full notes in Russian", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
  await page.goto("/");
  await page.getByLabel("Модель", { exact: true }).selectOption("checkout/checkout.model.json");
  await expect(page.getByLabel("Эксперимент", { exact: true })).toHaveValue("checkout/checkout.experiment.json");
  const description = page.locator(".model-description p");
  await expect(description).toContainText("Оформление заказа");
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  await expect(page.locator(".inspector-annotations")).not.toHaveAttribute("open");
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect(description).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Полные заметки", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`checkout-description-ru-${viewport.width}.png`) });
  }
  await page.getByTestId("rf__node-api-gateway").locator(".block-node-header").click();
  await page.getByRole("button", { name: "Свернуть инспектор", exact: true }).click();
  await page.getByRole("button", { name: "Полные заметки", exact: true }).click();
  const annotations = page.locator(".inspector-annotations");
  await expect(annotations).toHaveAttribute("open");
  await expect(annotations.getByRole("group", { name: "Модель", exact: true }).getByRole("textbox", { name: "Заметки", exact: true })).toBeFocused();
  await expect(annotations.getByRole("group", { name: "Эксперимент", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("checkout-notes-ru.png") });
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
