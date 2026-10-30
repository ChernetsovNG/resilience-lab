import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 10_000 });

test("checkout keeps its diagram while switching its two questions and remembers the last one", async ({ page }, testInfo) => {
  await page.goto("/");
  const model = page.getByLabel("Model", { exact: true });
  const experiment = page.getByLabel("Experiment", { exact: true });
  await model.selectOption("checkout/checkout.model.json");
  await expect(experiment.locator("option")).toHaveCount(2);
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
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/system.experiment.json`)}`);
    expect((await response.json()).content.experiment).toMatchObject({
      modelRef: "system.model.json", execution: { replications: 10 }, variants: [{ id: "baseline" }],
    });
    expect((await readdir(target)).sort()).toEqual(["system.experiment.json", "system.model.json"]);
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
