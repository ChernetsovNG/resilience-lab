import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExperimentFile } from "../src/api/apiTypes";

const experiment = "retry-storm/retry-storm.experiment.json";
const model = "retry-storm/retry-storm.model.json";

async function expectNoPageScroll(page: Page) {
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ horizontal: false, vertical: false });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await expect(page.getByLabel("Experiment")).toHaveValue(experiment);
  await expect(page.getByTestId("block-node")).toHaveCount(4);
});

test("validates zero handlers without saving and clears diagnostics after correction", async ({ page, request }, testInfo) => {
  const url = `/api/v1/workspace/document?path=${encodeURIComponent(model)}`;
  const original = await (await request.get(url)).json();
  const gateway = page.getByTestId("rf__node-gateway");
  await gateway.click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  const savedValue = await handlers.inputValue();
  await handlers.fill("0");
  await handlers.press("Enter");

  await expect(gateway.getByRole("img", { name: /problems: error/ })).toBeVisible();
  await expect(handlers.locator("..").locator(".field-diagnostics")).toContainText("PARAM_RANGE");
  await page.getByRole("tab", { name: "Problems", exact: true }).click();
  const problems = page.getByRole("tabpanel");
  await expect(problems.getByRole("button", { name: /PARAM_RANGE/ }).first()).toBeVisible();
  await expect(problems).toContainText("/blocks/gateway/params/handlers");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await problems.getByRole("button", { name: /PARAM_RANGE/ }).first().click();
  await expect(page.getByRole("tab", { name: "Model", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "gateway", exact: true })).toBeVisible();
  expect(await (await request.get(url)).json()).toEqual(original);
  await expectNoPageScroll(page);
  await page.screenshot({ path: testInfo.outputPath("draft-validation.png") });

  await handlers.fill(savedValue);
  await handlers.press("Enter");
  await expect(gateway.getByRole("img", { name: /problems: error/ })).toBeHidden();
  await expect(handlers.locator("..").locator(".field-diagnostics")).toBeHidden();
  await expect(problems.getByRole("button", { name: /PARAM_RANGE/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  expect(await (await request.get(url)).json()).toEqual(original);
});

test("shows variant pages read-only with their overrides and edits only on the model page", async ({ page }) => {
  await page.getByRole("tab", { name: "No retries" }).click();
  const call = page.getByTestId("rf__edge-gateway-to-middle");
  await expect(call).toContainText("· 1×");
  await call.click();

  const attempts = page.getByLabel("Attempts", { exact: true });
  await expect(attempts).toHaveValue("1");
  await expect(attempts).not.toBeEditable();
  await expect(page.locator(".param-field--overridden")).toContainText("overridden");

  await page.getByRole("tab", { name: "Baseline" }).click();
  await expect(attempts).toHaveValue("3");
  await expect(attempts).not.toBeEditable();

  await page.getByRole("tab", { name: "Model" }).click();
  await expect(attempts).toHaveValue("3");
  await expect(attempts).toBeEditable();
});

test("edits the model, saves it, runs the experiment and shows the summary", async ({ page, request }) => {
  await expectNoPageScroll(page);
  await page.getByTestId("rf__node-gateway").click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  await expect(handlers).toHaveValue("4");
  await handlers.fill("4.5");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await handlers.fill("6");
  await handlers.press("Enter");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(handlers).toHaveValue("4");
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(handlers).toHaveValue("6");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  const stored = await (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(model)}`)).json();
  expect(stored.content.model.blocks.gateway.params.handlers).toBe(6);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await page.reload();
  await page.getByTestId("rf__node-gateway").click();
  await expect(page.getByLabel("Handlers", { exact: true })).toHaveValue("6");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });
  const summary = page.getByRole("table", { name: "Summary" });
  await expect(summary.getByRole("row", { name: /Baseline/ })).toContainText("%");
  await expect(summary.getByRole("row", { name: /No retries/ })).toContainText("%");
  await expectNoPageScroll(page);
});

// Fixtures belong only to bootRunE2e's disposable workspace, never examples/.
async function withExperimentFixture(path: string, edit: (document: ExperimentFile) => void, exercise: () => Promise<void>) {
  const workspace = resolve("../apps/server/build/e2e-workspace");
  const root = resolve(workspace, path.split("/")[0]);
  await mkdir(root); // Refuse to replace a directory owned by another fixture.
  try {
    const directory = dirname(resolve(workspace, path));
    await mkdir(directory, { recursive: true });
    const document: ExperimentFile = JSON.parse(await readFile(resolve(workspace, experiment), "utf8"));
    document.modelRef = "fixture.model.json";
    document.layoutRef = "fixture.layout.json";
    edit(document);
    await copyFile(resolve(workspace, model), resolve(directory, document.modelRef));
    await copyFile(resolve(workspace, "retry-storm/retry-storm.layout.json"), resolve(directory, document.layoutRef));
    await writeFile(resolve(workspace, path), JSON.stringify(document));
    await exercise();
  } finally {
    await rm(root, { recursive: true });
  }
}

async function expectContainedApp(page: Page) {
  await expectNoPageScroll(page);
  const app = await page.locator(".app").evaluate((element) => ({
    width: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft,
  }));
  expect(app.scrollWidth).toBeLessThanOrEqual(app.width);
  expect(app.scrollLeft).toBe(0);
  const palette = await page.locator(".palette").boundingBox();
  const canvas = await page.locator(".canvas-area").boundingBox();
  const inspector = await page.getByRole("complementary", { name: "Inspector" }).boundingBox();
  expect(canvas!.x).toBe(palette!.x + palette!.width);
  expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(inspector!.x);
}

async function stationaryPanels(page: Page) {
  return Promise.all([".top-bar", ".palette", ".inspector"].map((selector) => page.locator(selector).boundingBox()));
}

test("keeps all twelve variant pages reachable inside the canvas column", async ({ page }) => {
  const path = "layout-regression-variants/many.experiment.json";
  await withExperimentFixture(path, (document) => {
    document.variants = Array.from({ length: 12 }, (_, index) => ({
      id: `configuration-${index + 1}`, label: `Configuration ${index + 1}`, overrides: {},
    }));
  }, async () => {
    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    await expect(page.getByRole("tab", { name: "Configuration 12", exact: true })).toBeAttached();
    await expect(page.getByTestId("block-node")).toHaveCount(4);
    const panels = await stationaryPanels(page);
    await expectContainedApp(page);
    for (let index = 1; index <= 12; index++) {
      const tab = page.getByRole("tab", { name: `Configuration ${index}`, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectContainedApp(page);
      expect(await stationaryPanels(page)).toEqual(panels);
    }
    expect(await page.getByRole("tablist", { name: "Pages" }).evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Model", exact: true })).toHaveAttribute("aria-selected", "true");
    await expectContainedApp(page);
    expect(await stationaryPanels(page)).toEqual(panels);
  });
});

test("keeps toolbar actions and health visible for a long experiment path in clean and dirty states", async ({ page }) => {
  const path = "experiments/service-chain/degraded-dependency/timeout-and-retry-policy-comparison/production-like-load.experiment.json";
  await withExperimentFixture(path, () => {}, async () => {
    await page.reload();
    const selector = page.getByLabel("Experiment");
    await selector.selectOption(path);
    await expect(selector).toHaveValue(path);
    await expect(selector.locator("option:checked")).toHaveText(path);
    await expect(page.getByTestId("block-node")).toHaveCount(4);
    async function expectToolbarContained() {
      for (const control of [page.getByRole("button", { name: "Save", exact: true }),
        page.getByRole("button", { name: "Run", exact: true }), page.getByText(/Backend healthy/)]) {
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
        expect(box!.y + box!.height).toBeLessThanOrEqual(720);
      }
      await expectContainedApp(page);
    }
    await expectToolbarContained();
    await page.getByTestId("rf__node-gateway").click();
    const handlers = page.getByLabel("Handlers", { exact: true });
    await handlers.fill("7");
    await handlers.press("Enter");
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expectToolbarContained();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    await expectToolbarContained();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  });
});
