import { expect, test as base, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { cp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("../apps/server/build/e2e-workspace");
const test = base.extend<{ directory: string }>({
  directory: async ({ page }, provide) => {
    const directory = `file-source-${randomUUID()}`;
    await cp(resolve("../examples/retry-storm"), resolve(root, directory), { recursive: true });
    try {
      await page.goto("/");
      await page.getByLabel("Experiment", { exact: true }).selectOption(`${directory}/retry-storm.experiment.json`);
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
async function createIn(page: Page, name: string, directory: string) {
  await action(page, name);
  const dialog = page.getByRole("dialog", { name, exact: true });
  await dialog.getByLabel("Destination directory").fill(directory);
  await dialog.getByRole("button", { name, exact: true }).click();
}
async function stored(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test("creates a runnable experiment with ten replications", async ({ page, directory }) => {
  const target = `file-new-${randomUUID()}`;
  try {
    await createIn(page, "New experiment", target);
    const path = `${target}/${target}.experiment.json`;
    await expect(page.getByLabel("Experiment", { exact: true })).toHaveValue(path);
    await expect(page.getByTestId("block-node")).toHaveCount(2);
    expect((await stored(page, path)).content.experiment.execution.replications).toBe(10);
    const validation = await page.request.post("/api/v1/validate", { data: { experiment: path } });
    expect((await validation.json()).valid).toBe(true);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    expect(directory).not.toBe(target);
  } finally { await rm(resolve(root, target), { recursive: true, force: true }); }
});

test("save as copies unsaved edits and leaves every source file unchanged", async ({ page, directory }) => {
  const target = `file-copy-${randomUUID()}`;
  const names = ["retry-storm.model.json", "retry-storm.layout.json", "retry-storm.experiment.json"];
  const before = await Promise.all(names.map(name => readFile(resolve(root, directory, name), "utf8")));
  try {
    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    await page.getByLabel("Handlers", { exact: true }).fill("7");
    await page.getByLabel("Handlers", { exact: true }).press("Enter");
    await createIn(page, "Save as", target);
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
  await action(page, "Save as");
  const dialog = page.getByRole("dialog", { name: "Save as", exact: true });
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
