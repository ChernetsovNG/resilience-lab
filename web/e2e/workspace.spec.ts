import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExperimentFile, ModelFile } from "../src/api/apiTypes";

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

test("keeps baseline lint warnings on their variant page and navigates there from Problems", async ({ page }) => {
  const call = page.getByTestId("rf__edge-gateway-to-middle");
  await call.click();
  const timeout = page.getByLabel("Timeout", { exact: true });
  const fieldMessages = timeout.locator("..").locator(".field-diagnostics");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await expect(fieldMessages).toBeHidden();
  await expect(page.getByRole("img", { name: /problems: warning/ })).toHaveCount(0);
  await expect(call).not.toContainText("⚠");

  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await expect(timeout).toHaveValue("80ms");
  await expect(fieldMessages).toContainText("LINT_TIMEOUT_BUDGET");
  await expect(call).toContainText("⚠ 1");
  await expect(page.getByTestId("rf__node-client").getByRole("img", { name: /problems: warning/ })).toBeVisible();

  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await timeout.fill("120ms");
  await timeout.press("Enter");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await expect(fieldMessages).toBeHidden();
  await expect(page.getByRole("img", { name: /problems: warning/ })).toHaveCount(0);
  await expect(call).not.toContainText("⚠");
  await page.getByRole("tab", { name: "Problems", exact: true }).click();
  const problems = page.getByRole("tabpanel");
  const warning = problems.getByRole("button", { name: /LINT_TIMEOUT_BUDGET/ });
  await expect(warning).toContainText("baseline");
  await expect(problems.getByRole("button", { name: /LINT_DEADLINE_BUDGET/ })).toContainText("baseline");
  await warning.click();
  await expect(page.getByRole("tab", { name: "Baseline", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(timeout).toHaveValue("80ms");
  await expect(fieldMessages).toContainText("LINT_TIMEOUT_BUDGET");
  await expectNoPageScroll(page);
});

test("keeps a warning from the only variant override off Model and opens its variant", async ({ page }) => {
  const path = "variant-warning/single.experiment.json";
  await withExperimentFixture(path, (document) => {
    document.variants = [{ id: "solo", label: "Solo", overrides: { "gateway.handlers": 1 } }];
  }, async () => {
    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    await page.getByTestId("rf__node-gateway").click();
    const handlers = page.getByLabel("Handlers", { exact: true });
    const fieldMessages = handlers.locator("..").locator(".field-diagnostics");
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await expect(handlers).toHaveValue("4");
    await expect(fieldMessages).toBeHidden();
    await expect(page.getByTestId("rf__node-gateway").getByRole("img", { name: /problems: warning/ })).toBeHidden();
    await page.getByRole("tab", { name: "Problems", exact: true }).click();
    const warning = page.getByRole("tabpanel").getByRole("button", { name: /LINT_HANDLERS_LITTLE/ });
    await expect(warning).toContainText("solo");
    await warning.click();
    await expect(page.getByRole("tab", { name: "Solo", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(handlers).toHaveValue("1");
    await expect(fieldMessages).toContainText("LINT_HANDLERS_LITTLE");
    await expectNoPageScroll(page);
  });
});

test("shows each variant with its own overrides and editable parameters", async ({ page }) => {
  await page.getByRole("tab", { name: "No retries" }).click();
  const call = page.getByTestId("rf__edge-gateway-to-middle");
  await expect(call).toContainText("· 1×");
  await call.click();

  const attempts = page.getByLabel("Attempts", { exact: true });
  await expect(attempts).toHaveValue("1");
  await expect(attempts).toBeEditable();
  await expect(page.locator(".param-field--overridden")).toContainText("overridden");

  await page.getByRole("tab", { name: "Baseline" }).click();
  await expect(attempts).toHaveValue("3");
  await expect(attempts).toBeEditable();

  await page.getByRole("tab", { name: "Model" }).click();
  await expect(attempts).toHaveValue("3");
  await expect(attempts).toBeEditable();
});

test("validates variant drafts on their own page and blocks Run until errors are fixed", async ({ page, request }) => {
  const path = "variant-validation/drafts.experiment.json";
  const document = async (path: string) => (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`)).json();
  await withExperimentFixture(path, () => {}, async () => {
    const original = await document(path);
    const modelPath = "variant-validation/fixture.model.json";
    const originalModel = await document(modelPath);
    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    await page.getByRole("tab", { name: "No retries", exact: true }).click();
    await page.getByTestId("rf__node-gateway").click();
    const handlers = page.getByLabel("Handlers", { exact: true });
    const fieldMessages = handlers.locator("..").locator(".field-diagnostics");
    await handlers.fill("0");
    await handlers.press("Enter");
    await expect(fieldMessages).toContainText("PARAM_RANGE");
    expect(await document(path)).toEqual(original);
    const run = page.getByRole("button", { name: "Run", exact: true });
    await expect(run).toHaveAttribute("title", "Fix validation errors before running");
    for (const name of ["Model", "Baseline"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(handlers).toHaveValue("4");
      await expect(fieldMessages).toBeHidden();
      await expect(run).toBeDisabled();
      await expect(run).toHaveAttribute("title", "Fix validation errors before running");
    }
    await page.getByRole("tab", { name: "Problems", exact: true }).click();
    await page.getByRole("tabpanel").getByRole("button", { name: /\/variants\/1\/overrides\/gateway\.handlers/ }).click();
    await expect(page.getByRole("tab", { name: "No retries", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(handlers).toHaveValue("0");
    await expect(fieldMessages).toContainText("PARAM_RANGE");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute("title", "Fix validation errors before running");
    await page.getByRole("button", { name: "Reset Handlers", exact: true }).click();
    await expect(handlers).toHaveValue("4");
    await expect(fieldMessages).toBeHidden();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    await expect(run).toBeEnabled();
    expect((await document(path)).content).toEqual(original.content);
    expect(await document(modelPath)).toEqual(originalModel);
    await expectNoPageScroll(page);
  });
});

test("saves variant field overrides without changing the model and restores model values", async ({ page, request }) => {
  const path = "variant-editor/edits.experiment.json";
  const modelPath = "variant-editor/fixture.model.json";
  const document = async (path: string) => (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`)).json();
  await withExperimentFixture(path, () => {}, async () => {
    const originalModel = (await document(modelPath)).content.model;
    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    await page.getByRole("tab", { name: "No retries", exact: true }).click();
    await page.getByTestId("rf__edge-gateway-to-middle").click();
    const timeout = page.getByLabel("Timeout", { exact: true });
    await timeout.fill("90ms");
    await timeout.press("Enter");
    const base = page.getByLabel("Base delay", { exact: true });
    await base.fill("4ms");
    await base.press("Enter");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    const edited = (await document(path)).content.experiment;
    expect(edited.variants[1].overrides).toMatchObject({
      "gateway-to-middle.timeout": "90ms", "gateway-to-middle.backoff.base": "4ms",
    });
    expect(edited.variants[1].overrides).not.toHaveProperty("gateway-to-middle.backoff");
    expect((await document(modelPath)).content.model).toEqual(originalModel);

    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    await page.getByRole("tab", { name: "No retries", exact: true }).click();
    await page.getByTestId("rf__edge-gateway-to-middle").click();
    await expect(timeout).toHaveValue("90ms");
    await expect(base).toHaveValue("4ms");
    await page.getByRole("button", { name: "Reset Timeout", exact: true }).click();
    await expect(timeout).toHaveValue("80ms");
    await page.getByRole("button", { name: "Reset Backoff", exact: true }).click();
    await expect(base).toHaveValue("2ms");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    const restored = (await document(path)).content.experiment;
    expect(restored.variants[1].overrides).not.toHaveProperty("gateway-to-middle.timeout");
    expect(restored.variants[1].overrides).not.toHaveProperty("gateway-to-middle.backoff.base");
    expect(restored.variants[1].overrides["gateway-to-middle.attempts"]).toBe(1);
    expect((await document(modelPath)).content.model).toEqual(originalModel);
    await expectNoPageScroll(page);
  });
});

test("adds a variant, edits shared run settings and faults, and runs three variants", async ({ page, request }) => {
  const path = "variant-run/three.experiment.json";
  await withExperimentFixture(path, () => {}, async () => {
    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    await page.getByRole("button", { name: "Add variant", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Variant 1", exact: true })).toHaveAttribute("aria-selected", "true");
    const label = page.getByLabel("Variant label", { exact: true });
    await label.fill("Alternative");
    await label.press("Enter");
    const id = page.getByLabel("Variant ID", { exact: true });
    await id.fill("alternative");
    await id.press("Enter");
    for (const [name, value] of [["Replications", "2"], ["Seed", "42"], ["Real-time limit", "10s"],
      ["Fault start", "100ms"], ["Fault end", "500ms"], ["Processing multiplier", "2"], ["Fault failure rate", "5%"]]) {
      const field = page.getByLabel(name, { exact: true });
      await field.fill(value);
      await field.press("Enter");
    }
    await page.getByRole("combobox", { name: "Fault target", exact: true }).selectOption("middle");
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await expect(page.getByLabel("Seed", { exact: true })).toHaveValue("42");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    const saved = await (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`)).json();
    expect(saved.content.experiment.variants[2]).toMatchObject({ id: "alternative", label: "Alternative", overrides: {} });
    expect(saved.content.experiment.execution).toMatchObject({ seed: 42, replications: 2, maxRealTime: "10s" });
    expect(saved.content.experiment.faults[0]).toEqual({ target: "middle", from: "100ms", to: "500ms", processingMultiplier: 2, failureRate: "5%" });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });
    const summary = page.getByRole("table", { name: "Summary" });
    await expect(summary.locator("tbody tr")).toHaveCount(3);
    await expect(summary.getByRole("row", { name: /Alternative/ })).toContainText("%");
    await expectNoPageScroll(page);
  });
});

test("preserves an absent optional field when editing an existing object override", async ({ page, request }) => {
  const path = "variant-object/processing.experiment.json";
  await withExperimentFixture(path, (document) => {
    document.variants[1].overrides["gateway.processing"] = { kind: "fixed", mean: "3ms" };
  }, async () => {
    const modelFile = resolve("../apps/server/build/e2e-workspace/variant-object/fixture.model.json");
    const source: ModelFile = JSON.parse(await readFile(modelFile, "utf8"));
    source.blocks.gateway.params.processing = { kind: "lognormal", mean: "2ms", stdDev: "1ms" };
    await writeFile(modelFile, JSON.stringify(source));
    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    await page.getByRole("tab", { name: "No retries", exact: true }).click();
    await page.getByTestId("rf__node-gateway").click();
    const mean = page.getByLabel("Mean", { exact: true });
    await mean.fill("4ms");
    await mean.press("Enter");
    const deviation = page.getByLabel("Standard deviation", { exact: true });
    await expect(deviation).toHaveValue("");
    await deviation.fill("2ms");
    await deviation.press("Enter");
    await deviation.fill("");
    await deviation.press("Enter");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    const saved = await (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`)).json();
    expect(saved.content.experiment.variants[1].overrides).toMatchObject({
      "gateway.processing.kind": "fixed", "gateway.processing.mean": "4ms", "gateway.processing.stdDev": null,
    });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });
    expect(JSON.parse(await readFile(modelFile, "utf8"))).toEqual(source);
  });
});

test("preserves grid axes when saving and shows every point from the real API", async ({ page, request }) => {
  const path = "parameter-grid/grid.experiment.json";
  const grid = [
    { path: "gateway-to-middle.timeout", values: ["40ms", "80ms"] },
    { path: "gateway-to-middle.attempts", values: [1, 2, 3] },
  ];
  await withExperimentFixture(path, (document) => { document.grid = grid; }, async () => {
    await page.reload();
    await page.getByLabel("Experiment").selectOption(path);
    const seed = page.getByLabel("Seed", { exact: true });
    await seed.fill("42");
    await seed.press("Enter");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
    const saved = await (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`)).json();
    expect(saved.content.experiment.grid).toEqual(grid);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });
    const summary = page.getByRole("table", { name: "Summary" });
    await expect(summary.locator("tbody tr")).toHaveCount(12);
    await expect(summary.getByRole("row", { name: /Baseline p0 / })).toContainText("gateway-to-middle.timeout = 40ms");
    await expect(summary.getByRole("row", { name: /Baseline p5 / })).toContainText("gateway-to-middle.attempts = 3");
    await expect(summary.getByRole("row", { name: /No retries p5 / })).toContainText("%");
    await expectNoPageScroll(page);
  });
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
