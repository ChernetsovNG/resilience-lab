import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile } from "../src/api/apiTypes";
import { expect, selectExperiment, test, type Page } from "./fixtures";

test.use({ actionTimeout: 10_000 });

async function stored(page: Page, path: string): Promise<ModelFile> {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).content.model;
}

test("preserves v6 clients, classes, filters and call policies through editing and saving", async ({ page }) => {
  const directory = `request-classes-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  const modelPath = `${directory}/retry-storm.model.json`;
  const experimentPath = `${directory}/retry-storm.experiment.json`;
  await cp(resolve("../examples/retry-storm"), target, { recursive: true, errorOnExist: true, force: false });
  try {
    const source: ModelFile = JSON.parse(await readFile(resolve(target, "retry-storm.model.json"), "utf8"));
    source.schemaVersion = 6;
    const classes = [
      { id: "status", load: { points: [{ time: "0s", rate: "80/s" }] } },
      { id: "checkout", load: { points: [{ time: "0s", rate: "20/s" }, { time: "1s", rate: "60/s" }] } },
    ];
    source.blocks.client.params = { deadline: "2s", classes };
    source.blocks.partner = { type: "client", params: { deadline: "1s", classes: [classes[0]] } };
    source.blocks.router = { type: "router", params: { policy: "roundRobin" } };
    source.blocks.gateway.scenario = [
      { type: "process", classes: ["checkout"] },
      { type: "call", connection: "gateway-to-middle", classes: ["checkout"] },
    ];
    const policies = {
      circuitBreaker: { failureRate: "40%", minimumCalls: 5, window: 10, openDuration: "20ms", halfOpenCalls: 2 },
      retryBudget: { ratio: "20%", minPerSecond: "0/s", window: "100ms" },
      fallback: { on: ["circuitOpen", "timeout"], processing: "2ms" },
    };
    const call = source.connections.find(edge => edge.id === "gateway-to-middle")!;
    call.params = { ...call.params, ...policies };
    source.connections.find(edge => edge.id === "middle-to-dependency")!.to = "router";
    source.connections.push(
      { id: "partner-to-gateway", type: "request", from: "partner", to: "gateway", params: {} },
      { id: "checkout-route", type: "route", from: "router", to: "dependency", params: {}, classes: ["checkout"] },
    );
    const experiment: ExperimentFile = JSON.parse(await readFile(resolve(target, "retry-storm.experiment.json"), "utf8"));
    const override = [{ id: "status", load: { points: [{ time: "0s", rate: "100/s" }] } }, classes[1]];
    experiment.variants[1].overrides["client.classes"] = override;
    experiment.variants[1].overrides["gateway-to-middle.retryBudget.ratio"] = "35%";
    experiment.grid = [{ path: "gateway-to-middle.retryBudget.ratio", values: ["10%", "20%"] }];
    await writeFile(resolve(target, "retry-storm.model.json"), JSON.stringify(source));
    await writeFile(resolve(target, "retry-storm.experiment.json"), JSON.stringify(experiment));
    await page.goto("/");
    await selectExperiment(page, experimentPath);
    await expect(page.getByTestId("block-node")).toHaveCount(6);
    const expected = await stored(page, modelPath);
    expect(expected.blocks.client.params.classes).toEqual(classes);
    expect(expected.connections.find(edge => edge.id === "gateway-to-middle")!.params).toMatchObject(policies);
    expect(expected.connections.find(edge => edge.id === "checkout-route")!.classes).toEqual(["checkout"]);

    await page.getByTestId("rf__node-client").locator(".block-node > strong").click();
    const classField = page.locator('[data-inspector-field="classes"] textarea');
    await expect(classField).toBeVisible();
    await expect(classField).not.toBeEditable();
    expect(JSON.parse(await classField.inputValue())).toEqual(classes);
    await expect(page.getByRole("table", { name: "Load points" })).toHaveCount(0);
    await page.getByLabel("Deadline", { exact: true }).fill("3s");
    await page.getByLabel("Deadline", { exact: true }).press("Enter");
    expected.blocks.client.params.deadline = "3s";

    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    const scenario = page.locator(".inspector-scenario");
    if (await scenario.getAttribute("open") === null) await scenario.locator("summary").click();
    await page.getByRole("group", { name: "Step 1", exact: true }).getByRole("combobox", { name: "Step type", exact: true }).selectOption("call");
    expected.blocks.gateway.scenario![0] = {
      type: "call", connection: "gateway-to-middle", classes: ["checkout"], processing: null, failureRate: null,
    };
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeHidden();
    expect(await stored(page, modelPath)).toEqual(expected);
    const savedExperiment = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(experimentPath)}`);
    const savedExperimentContent = (await savedExperiment.json()).content.experiment;
    expect(savedExperimentContent.grid).toEqual(experiment.grid);
    const savedOverrides = savedExperimentContent.variants[1].overrides;
    expect(savedOverrides["client.classes"]).toEqual(override);
    expect(savedOverrides["gateway-to-middle.retryBudget.ratio"]).toBe("35%");
    const validation = await page.request.post("/api/v1/validate", { data: { experiment: experimentPath } });
    expect(validation.ok()).toBe(true);
    expect((await validation.json()).valid).toBe(true);

    await page.reload();
    await expect(page.getByTestId("block-node")).toHaveCount(6);
    expect(await stored(page, modelPath)).toEqual(expected);
  } finally {
    await rm(target, { recursive: true });
  }
});
