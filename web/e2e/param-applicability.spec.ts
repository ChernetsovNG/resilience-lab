import { cp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ModelFile } from "../src/api/apiTypes";
import { expect, selectExperiment, test } from "./fixtures";

test("saves and reloads a valid connection after fixed, lognormal and fixed distribution changes", async ({ page }) => {
  const directory = `param-applicability-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  const modelPath = `${directory}/retry-storm.model.json`;
  await cp(resolve("../examples/retry-storm"), target, { recursive: true, errorOnExist: true, force: false });
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
    expect(response.ok()).toBe(true);
    saved = (await response.json()).content.model;
    expect(saved.connections.find(edge => edge.id === "gateway-to-middle")!.params.network).toEqual({ kind: "fixed", mean });
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  } finally {
    await rm(target, { recursive: true });
  }
});
