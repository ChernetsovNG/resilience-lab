import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile } from "../src/api/apiTypes";
import en from "../src/i18n/en.json" with { type: "json" };
import { cleanupWorkspace, copyRetryStorm, expect, readWorkspaceDocument, selectExperiment, test } from "./fixtures";

test("opens and saves nested cache documents without changing read-only fields", async ({ page }) => {
  const directory = "cache-documents-" + randomUUID();
  const root = resolve("../apps/server/build/e2e-workspace", directory);
  await copyRetryStorm(root);
  const modelPath = directory + "/retry-storm.model.json";
  const experimentPath = directory + "/retry-storm.experiment.json";
  const documentUrl = (path: string) => "/api/v1/workspace/document?path=" + encodeURIComponent(path);
  try {
    const model: ModelFile = JSON.parse(await readFile(resolve(root, "retry-storm.model.json"), "utf8"));
    model.blocks.redis = { type: "cache", title: "Кэш товаров", params: {
      capacity: 100, keySpaces: [{ id: "product", keys: 1000, zipf: 1, ttl: "30s" }],
      prefill: { kind: "hot", keys: 10 },
    } };
    model.blocks.gateway.title = "Товары";
    model.blocks.gateway.scenario = [{ type: "parallel", id: "fanout", branches: [[{
      type: "cacheRead", id: "product-read", connection: "gateway-to-redis", keySpace: "product",
      repeat: { count: 20, mode: "parallel" }, singleFlight: true, onCacheError: "source",
      onMiss: [{ type: "call", connection: "gateway-to-middle" }],
    }]] }];
    model.connections.push({ id: "gateway-to-redis", type: "call", from: "gateway", to: "redis", params: { timeout: "50ms" } });
    const experiment: ExperimentFile = JSON.parse(await readFile(resolve(root, "retry-storm.experiment.json"), "utf8"));
    experiment.faults = [{ target: "redis", kind: "flush", at: "200ms" }];
    experiment.variants[0].overrides = { ...experiment.variants[0].overrides, "gateway.steps.product-read.repeat.count": 2 };
    experiment.grid = [{ path: "gateway.steps.product-read.repeat.count", values: [2, 4] }];
    await writeFile(resolve(root, "retry-storm.model.json"), JSON.stringify(model));
    await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
    await page.goto("/");
    await selectExperiment(page, experimentPath);
    await expect(page.getByTestId("block-node")).toHaveCount(5);
    const before = await readWorkspaceDocument(page.request, documentUrl(modelPath));
    const beforeExperiment = await readWorkspaceDocument(page.request, documentUrl(experimentPath));
    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    await expect(page.getByLabel(en["editor.scenario.readOnly"], { exact: true })).toContainText('"keySpace": "product"');
    await expect(page.getByLabel(en["editor.block.title"], { exact: true })).toHaveAttribute("readonly");
    await expect(page.getByRole("combobox", { name: en["editor.scenario.type"], exact: true })).toHaveCount(0);
    await page.getByLabel(en["catalog.types.service.params.handlers.title"], { exact: true }).fill("5");
    await page.getByLabel(en["catalog.types.service.params.handlers.title"], { exact: true }).press("Enter");
    await page.getByRole("button", { name: en["app.topBar.save"], exact: true }).click();
    await expect(page.locator(".dirty-mark")).toBeHidden();
    const saved = await readWorkspaceDocument(page.request, documentUrl(modelPath));
    const savedExperiment = await readWorkspaceDocument(page.request, documentUrl(experimentPath));
    expect(saved.content.model.blocks.gateway).toEqual({
      ...before.content.model.blocks.gateway, params: { ...before.content.model.blocks.gateway.params, handlers: 5 },
    });
    expect(saved.content.model.blocks.redis).toEqual(before.content.model.blocks.redis);
    expect(savedExperiment.content.experiment).toEqual(beforeExperiment.content.experiment);
    await page.reload();
    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    await expect(page.getByLabel(en["editor.scenario.readOnly"], { exact: true })).toContainText('"count": 20');
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    await expect.poll(async () => {
      const steps = JSON.parse(await page.getByLabel(en["editor.scenario.readOnly"], { exact: true }).innerText());
      return steps[0].branches[0][0].repeat.count;
    }).toBe(2);
  } finally {
    await cleanupWorkspace(page, root);
  }
});
