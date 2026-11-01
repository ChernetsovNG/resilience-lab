import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile } from "../src/api/apiTypes";
import { cleanupWorkspace, copyRetryStorm, expect, selectExperiment, test } from "./fixtures";

test("confirms dependent sweep and override removal, undoes both documents, then saves and reloads valid documents", async ({ page }) => {
  const directory = `param-dependents-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  const experimentPath = `${directory}/retry-storm.experiment.json`;
  await copyRetryStorm(target);
  try {
    const sourceModel: ModelFile = JSON.parse(await readFile(resolve(target, "retry-storm.model.json"), "utf8"));
    sourceModel.blocks.gateway.params.processing = { kind: "lognormal", mean: "2ms", stdDev: "1ms" };
    await writeFile(resolve(target, "retry-storm.model.json"), JSON.stringify(sourceModel));
    const sourceExperiment: ExperimentFile = JSON.parse(await readFile(resolve(target, "retry-storm.experiment.json"), "utf8"));
    const unrelatedOverrides = { ...sourceExperiment.variants[1].overrides };
    sourceExperiment.variants[1].overrides["gateway.processing.stdDev"] = "3ms";
    // stdDev is not offered as a sweepable field; load an existing reference to exercise its cleanup.
    sourceExperiment.grid = [{ path: "gateway.processing.stdDev", values: ["1ms", "2ms"] }];
    await writeFile(resolve(target, "retry-storm.experiment.json"), JSON.stringify(sourceExperiment));
    await page.goto("/");
    await selectExperiment(page, experimentPath);
    await page.getByRole("button", { name: "Run settings", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Axis 1 parameter", exact: true })).toHaveValue("gateway.processing.stdDev");
    await expect(page.getByText("Unsaved changes")).toBeHidden();

    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    const distribution = page.getByRole("group", { name: "Processing time" }).getByRole("combobox", { name: "Distribution" });
    await distribution.selectOption("fixed");
    const dialog = page.getByRole("dialog", { name: "Remove dependent settings?" });
    await expect(dialog).toContainText("Standard deviation");
    await expect(dialog).toContainText(sourceExperiment.variants[1].label!);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(distribution).toHaveValue("lognormal");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await distribution.selectOption("fixed");
    await dialog.getByRole("button", { name: "Change", exact: true }).click();
    await expect(distribution).toHaveValue("fixed");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(distribution).toHaveValue("lognormal");
    await page.getByRole("button", { name: "Run settings", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Axis 1 parameter", exact: true })).toHaveValue("gateway.processing.stdDev");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Axis 1 parameter", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    await page.reload();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    const storedModel = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.model.json`)}`);
    expect(storedModel.ok(), `HTTP ${storedModel.status()}: ${await storedModel.text()}`).toBe(true);
    expect((await storedModel.json()).content.model.blocks.gateway.params.processing).toEqual({ kind: "fixed", mean: "2ms" });
    const storedExperiment = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(experimentPath)}`);
    expect(storedExperiment.ok(), `HTTP ${storedExperiment.status()}: ${await storedExperiment.text()}`).toBe(true);
    const saved: ExperimentFile = (await storedExperiment.json()).content.experiment;
    expect(saved.grid).toEqual([]);
    expect(saved.variants[1].overrides).toEqual(unrelatedOverrides);
    const validation = await page.request.post("/api/v1/validate", { data: { experiment: experimentPath } });
    expect(validation.ok()).toBe(true);
    expect((await validation.json()).valid).toBe(true);
  } finally {
    await cleanupWorkspace(page, target);
  }
});

test("saves and reloads a valid connection after fixed, lognormal and fixed distribution changes", async ({ page }) => {
  const directory = `param-applicability-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  const modelPath = `${directory}/retry-storm.model.json`;
  await copyRetryStorm(target);
  try {
    await page.goto("/");
    await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
    await page.getByTestId("canvas-param-gateway-to-middle-timeout").click();
    const network = page.getByRole("complementary", { name: "Inspector" }).getByRole("group", { name: "Network delay" });
    const mean = await network.getByRole("textbox", { name: "Mean", exact: true }).inputValue();
    await expect(network.getByRole("textbox", { name: "Standard deviation" })).toHaveCount(0);
    await network.getByRole("combobox", { name: "Distribution" }).selectOption("lognormal");
    await expect(network.getByRole("textbox", { name: "Standard deviation" })).toHaveValue(mean);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    let saved: ModelFile = JSON.parse(await readFile(resolve(target, "retry-storm.model.json"), "utf8"));
    expect(saved.connections.find(edge => edge.id === "gateway-to-middle")!.params.network).toEqual({ kind: "lognormal", mean, stdDev: mean });
    await network.getByRole("combobox", { name: "Distribution" }).selectOption("fixed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    await page.reload();
    await page.getByTestId("canvas-param-gateway-to-middle-timeout").click();
    await expect(network.getByRole("combobox", { name: "Distribution" })).toHaveValue("fixed");
    await expect(network.getByRole("textbox", { name: "Standard deviation" })).toHaveCount(0);
    const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`);
    expect(response.ok(), `HTTP ${response.status()}: ${await response.text()}`).toBe(true);
    saved = (await response.json()).content.model;
    expect(saved.connections.find(edge => edge.id === "gateway-to-middle")!.params.network).toEqual({ kind: "fixed", mean });
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  } finally {
    await cleanupWorkspace(page, target);
  }
});
