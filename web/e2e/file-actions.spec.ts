import { selectExperiment } from "./fixtures";
import { expect, test as base, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("../apps/server/build/e2e-workspace");
const test = base.extend<{ directory: string }>({
  directory: async ({ page }, provide) => {
    const directory = `file-source-${randomUUID()}`;
    await cp(resolve("../examples/retry-storm"), resolve(root, directory), { recursive: true });
    try {
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      await expect(page.getByTestId("block-node")).toHaveCount(4);
      await provide(directory);
    } finally { await rm(resolve(root, directory), { recursive: true, force: true }); }
  },
});
test.use({ actionTimeout: 10_000 });

async function action(page: Page, name: string) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function createIn(page: Page, name: string, directory: string, fromList = false) {
  if (fromList) await page.getByRole("combobox", { name: name === "New model" ? "Model" : "Experiment", exact: true })
    .selectOption({ label: `+ ${name}…` });
  else await action(page, name);
  const dialog = page.getByRole("dialog", { name, exact: true });
  await dialog.getByLabel(name === "New model" ? "Model name" : name === "New experiment" ? "Experiment name" : "Destination directory").fill(directory);
  await dialog.getByRole("button", { name, exact: true }).click();
}
async function stored(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

for (const [label, title] of [["Model", "New model"], ["Experiment", "New experiment"]]) {
  test(`creation from ${label} preserves selection and unsaved edits on cancellation`, async ({ page, directory }) => {
    const selector = page.getByRole("combobox", { name: label, exact: true });
    const previous = await selector.inputValue();
    await expect(page.locator(".top-bar button").first()).toHaveText("File");
    await selector.selectOption({ label: `+ ${title}…` });
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(selector).toHaveValue(previous);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(selector).toHaveValue(previous);

    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    await page.getByLabel("Handlers", { exact: true }).fill("7");
    await page.getByLabel("Handlers", { exact: true }).press("Enter");
    page.once("dialog", confirmation => confirmation.dismiss());
    await selector.selectOption({ label: `+ ${title}…` });
    await expect(dialog).not.toBeVisible();
    await expect(selector).toHaveValue(previous);
    await expect(page.getByLabel("Handlers", { exact: true })).toHaveValue("7");
    expect((await stored(page, `${directory}/retry-storm.model.json`)).content.model.blocks.gateway.params.handlers).not.toBe(7);
  });
}

test("deleting an experiment removes its completed run from the API and disk", async ({ page, directory }) => {
  const experiment = `${directory}/retry-storm.experiment.json`;
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  const runs: { experiment: string; directory: string }[] = await (await page.request.get("/api/v1/runs")).json();
  const owned = runs.filter(run => run.experiment === experiment);
  expect(owned).toHaveLength(1);
  await action(page, "Delete experiment…");
  const dialog = page.getByRole("dialog", { name: "Delete experiment…", exact: true });
  await expect(dialog.getByText(/Runs: 1, total:/)).toBeVisible();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/v1/runs")).json() as typeof runs)
    .filter(run => run.experiment === experiment)).toEqual([]);
  for (const run of owned) await expect(stat(resolve(root, run.directory))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stored(page, `${directory}/retry-storm.model.json`)).content.model).toBeDefined();
});

test("cleans up an old artifact through the file menu and removes its directory", async ({ page }) => {
  const directory = `.results/obsolete-${randomUUID()}/old-run`;
  const experiment = "deleted/old.experiment.json";
  await mkdir(resolve(root, directory), { recursive: true });
  await writeFile(resolve(root, directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, experiment }));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "File", exact: true }).click();
    const cleanup = page.getByRole("button", { name: "Clean up obsolete runs…", exact: true });
    await expect(cleanup).toBeEnabled();
    await cleanup.click();
    const dialog = page.getByRole("dialog", { name: "Clean up obsolete runs…", exact: true });
    await expect(dialog.getByText(new RegExp(experiment))).toBeVisible();
    await expect(dialog.getByText(/Runs: 1, total:/)).toBeVisible();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(stat(resolve(root, directory))).rejects.toMatchObject({ code: "ENOENT" });
    const remaining: { directory: string }[] = await (await page.request.get("/api/v1/runs/obsolete")).json();
    expect(remaining.map(run => run.directory)).not.toContain(directory);
  } finally { await rm(resolve(root, directory), { recursive: true, force: true }); }
});

test("deletes a newly created model and its files, then returns to the last model", async ({ page, directory }) => {
  const target = `file-delete-${randomUUID()}`;
  try {
    await createIn(page, "New model", target);
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(`${target}/${target}.model.json`);
    await action(page, "Delete model…");
    const dialog = page.getByRole("dialog", { name: "Delete model…", exact: true });
    for (const kind of ["experiment", "layout", "model"]) {
      await expect(dialog.getByText(`${target}/${target}.${kind}.json`, { exact: true })).toBeVisible();
    }
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(`${directory}/retry-storm.model.json`);
    await expect(page.getByLabel("Model", { exact: true }).locator(`option[value="${target}/${target}.model.json"]`)).toHaveCount(0);
    for (const kind of ["experiment", "layout", "model"]) {
      const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${target}/${target}.${kind}.json`)}`);
      expect(response.status()).toBe(404);
    }
    expect((await stored(page, `${directory}/retry-storm.model.json`)).content.model).toBeDefined();
  } finally { await rm(resolve(root, target), { recursive: true, force: true }); }
});

test("creates an empty model and runs a system built from the palette", async ({ page, directory }, testInfo) => {
  const target = `file-new-${randomUUID()}`;
  try {
    await createIn(page, "New model", target, true);
    const path = `${target}/${target}.experiment.json`;
    await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(path);
    await expect(page.getByTestId("block-node")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Add a client from the palette", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(`${target}/${target}.model.json`);
    expect((await stored(page, path)).content.experiment).toMatchObject({ schemaVersion: 2, execution: { replications: 10 } });
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toHaveAttribute("title", "Add a client from the palette");
    await page.getByRole("tab", { name: "Problems", exact: true }).click();
    await expect(page.locator(".validation-problems li")).toHaveCount(0);
    await page.getByRole("button", { name: "Collapse results", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("empty-model.png") });
    const palette = page.getByRole("complementary", { name: "Palette" });
    await palette.getByRole("button", { name: "Client", exact: true }).dblclick();
    await palette.getByRole("button", { name: "Service", exact: true }).dblclick();
    await page.locator(".react-flow__controls-fitview").click();
    await page.getByTestId("rf__node-client-1").locator('[data-handleid="out"]').dragTo(
      page.getByTestId("rf__node-service-1").locator('[data-handleid="in"]'));
    await expect(page.getByTestId("rf__edge-client-1-to-service-1")).toBeAttached();
    await expect(page.getByText("Add a client from the palette", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    const report = await (await page.request.post("/api/v1/validate", { data: { experiment: path } })).json();
    expect(report.valid).toBe(true);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    expect(directory).not.toBe(target);
  } finally { await rm(resolve(root, target), { recursive: true, force: true }); }
});

test("creates a new question for the current model without changing its source experiment", async ({ page, directory }) => {
  const source = resolve(root, directory, "retry-storm.experiment.json");
  const before = await readFile(source, "utf8");
  await createIn(page, "New experiment", "capacity", true);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(`${directory}/retry-storm.model.json`);
  await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(`${directory}/capacity.experiment.json`);
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  expect((await stored(page, `${directory}/capacity.experiment.json`)).content.experiment).toMatchObject({
    schemaVersion: 2, modelRef: "retry-storm.model.json", layoutRef: "retry-storm.layout.json", execution: { replications: 10 },
    faults: [], grid: [], variants: [{ id: "baseline", overrides: {} }],
  });
  expect(await readFile(source, "utf8")).toBe(before);
});

test("save as copies unsaved edits and leaves every source file unchanged", async ({ page, directory }) => {
  const target = `file-copy-${randomUUID()}`;
  const names = ["retry-storm.model.json", "retry-storm.layout.json", "retry-storm.experiment.json"];
  const before = await Promise.all(names.map(name => readFile(resolve(root, directory, name), "utf8")));
  try {
    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    await page.getByLabel("Handlers", { exact: true }).fill("7");
    await page.getByLabel("Handlers", { exact: true }).press("Enter");
    await createIn(page, "Save model as", target);
    await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(`${target}/retry-storm.experiment.json`);
    expect((await stored(page, `${target}/retry-storm.model.json`)).content.model.blocks.gateway.params.handlers).toBe(7);
    expect((await stored(page, `${target}/retry-storm.experiment.json`)).content.experiment.modelRef).toBe("retry-storm.model.json");
    expect(await Promise.all(names.map(name => readFile(resolve(root, directory, name), "utf8")))).toEqual(before);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  } finally { await rm(resolve(root, target), { recursive: true, force: true }); }
});

test("exports canonical files and imports the same experiment into another directory", async ({ page, directory }) => {
  const target = `file-import-${randomUUID()}`;
  const downloads: Promise<{ name: string; mimeType: string; buffer: Buffer }>[] = [];
  page.on("download", download => downloads.push((async () => ({
    name: download.suggestedFilename(), mimeType: "application/json", buffer: await readFile((await download.path())!),
  }))()));
  try {
    await action(page, "Export");
    await expect.poll(() => downloads.length).toBe(3);
    const files = await Promise.all(downloads);
    for (const file of files) {
      const response = await page.request.get(`/api/v1/workspace/document/text?path=${encodeURIComponent(`${directory}/${file.name}`)}`);
      expect(file.buffer.toString("utf8")).toBe(await response.text());
    }
    await action(page, "Import");
    const dialog = page.getByRole("dialog", { name: "Import", exact: true });
    await dialog.getByLabel("Destination directory").fill(target);
    await dialog.getByLabel("Document files").setInputFiles(files);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(`${target}/retry-storm.experiment.json`);
    for (const file of files) {
      expect((await stored(page, `${target}/${file.name}`)).content).toEqual((await stored(page, `${directory}/${file.name}`)).content);
      expect(await readFile(resolve(root, target, file.name), "utf8")).toBe(file.buffer.toString("utf8"));
    }
  } finally { await rm(resolve(root, target), { recursive: true, force: true }); }
});

test("rejects an unsupported seed through ordinary validation without writing files", async ({ page, directory }) => {
  const target = `file-long-${randomUUID()}`;
  try {
    const files = await Promise.all(["model", "layout", "experiment"].map(async kind => {
      const name = `retry-storm.${kind}.json`;
      let text = await readFile(resolve(root, directory, name), "utf8");
      if (kind === "experiment") text = text.replace(/("seed"\s*:\s*)\d+/, (_match, prefix) => `${prefix}9007199254740993`);
      return { name, mimeType: "application/json", buffer: Buffer.from(text) };
    }));
    await action(page, "Import");
    const dialog = page.getByRole("dialog", { name: "Import", exact: true });
    await dialog.getByLabel("Destination directory").fill(target);
    await dialog.getByLabel("Document files").setInputFiles(files);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(`${directory}/retry-storm.experiment.json`);
    await expect(page.getByRole("tabpanel")).toContainText("seed must be an integer from 0");
    for (const kind of ["model", "layout", "experiment"]) {
      const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${target}/retry-storm.${kind}.json`)}`);
      expect(response.status()).toBe(404);
    }
  } finally { await rm(resolve(root, target), { recursive: true, force: true }); }
});

test("canceling replacement preserves existing files", async ({ page, directory }) => {
  const path = resolve(root, directory, "retry-storm.model.json");
  const before = await readFile(path, "utf8");
  const changed = JSON.parse(before);
  changed.description = "Replacement must be canceled";
  await action(page, "Import");
  const dialog = page.getByRole("dialog", { name: "Import", exact: true });
  await dialog.getByLabel("Destination directory").fill(directory);
  await dialog.getByLabel("Document files").setInputFiles({
    name: "retry-storm.model.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(changed)),
  });
  page.once("dialog", confirmation => confirmation.dismiss());
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await readFile(path, "utf8")).toBe(before);
});

test("confirmed replacement imports a document and reloads its experiment", async ({ page, directory }) => {
  const path = resolve(root, directory, "retry-storm.model.json");
  const changed = JSON.parse(await readFile(path, "utf8"));
  changed.blocks.gateway.params.handlers = 7;
  await action(page, "Import");
  const dialog = page.getByRole("dialog", { name: "Import", exact: true });
  await dialog.getByLabel("Destination directory").fill(directory);
  await dialog.getByLabel("Document files").setInputFiles({
    name: "retry-storm.model.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(changed)),
  });
  page.once("dialog", confirmation => confirmation.accept());
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await expect(page.getByLabel("Handlers", { exact: true })).toHaveValue("7");
  expect((await stored(page, `${directory}/retry-storm.model.json`)).content.model.blocks.gateway.params.handlers).toBe(7);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("file dialogs isolate document editing shortcuts", async ({ page, directory }) => {
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  await page.getByLabel("Handlers", { exact: true }).fill("7");
  await page.getByLabel("Handlers", { exact: true }).press("Enter");
  await action(page, "Save model as");
  const dialog = page.getByRole("dialog", { name: "Save model as", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await cancel.focus();
  await cancel.press("Delete");
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await cancel.press("Backspace");
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await cancel.press("Control+z");
  await expect(page.getByLabel("Handlers", { exact: true })).toHaveValue("7");
  await cancel.click();
  await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(`${directory}/retry-storm.experiment.json`);
});

test("malformed import opens Problems without changing the current experiment", async ({ page, directory }) => {
  await action(page, "Import");
  const dialog = page.getByRole("dialog", { name: "Import", exact: true });
  await dialog.getByLabel("Destination directory").fill(`file-invalid-${randomUUID()}`);
  await dialog.getByLabel("Document files").setInputFiles({ name: "broken.model.json", mimeType: "application/json", buffer: Buffer.from("{") });
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("tab", { name: /^Problems/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("Cannot read a JSON document from broken.model.json.");
  await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(`${directory}/retry-storm.experiment.json`);
});
