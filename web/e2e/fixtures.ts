import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile } from "../src/api/apiTypes";
import type { Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";
import { initializeLanguage } from "../src/i18n";

export { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** Every scenario fails on unexpected browser errors, including ResizeObserver delivery loops. */
export const test = base.extend<{ expectedPageErrors: RegExp[]; pageErrors: void }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright discovers fixture dependencies through destructuring.
  expectedPageErrors: async ({}, provide) => { await provide([]); },
  pageErrors: [async ({ page, expectedPageErrors }, use) => {
    await initializeLanguage();
    const errors: string[] = [];
    const pageError = (error: Error) => errors.push(`pageerror: ${error.message}`);
    const consoleError = (message: import("@playwright/test").ConsoleMessage) => {
      if (message.type() === "error") errors.push(`console.error: ${message.text()} (${message.location().url})`);
    };
    page.on("pageerror", pageError);
    page.on("console", consoleError);
    await use();
    page.off("pageerror", pageError);
    page.off("console", consoleError);
    expect(errors.filter(error => error.includes("ResizeObserver loop") ||
      !expectedPageErrors.some(expected => expected.test(error))), "Unexpected browser errors").toEqual([]);
  }, { auto: true }],
});

/** Opens a question through its owning model, independent of the remembered model and interface language. */
export async function selectExperiment(page: Page, path: string): Promise<void> {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  if (!response.ok()) throw new Error(`Cannot open ${path}: HTTP ${response.status()}`);
  const { content } = await response.json();
  const model = new URL(content.experiment.modelRef, `http://workspace/${path}`).pathname.slice(1);
  await page.getByRole("combobox", { name: /^(Model|Модель)$/ }).selectOption(model);
  await page.getByRole("combobox", { name: /^(Experiment|Эксперимент)$/ }).selectOption(path);
}

/** Copies a short UI fixture into an existing, test-owned workspace directory. */
export async function copySmallExperiment(directory: string, name = "retry-storm.experiment.json", window = "50ms"): Promise<ExperimentFile> {
  const source = resolve("../examples/retry-storm");
  for (const file of ["retry-storm.model.json", "retry-storm.layout.json"]) {
    await copyFile(resolve(source, file), resolve(directory, file));
  }
  const experiment: ExperimentFile = JSON.parse(await readFile(resolve(source, "retry-storm.experiment.json"), "utf8"));
  // Layout scenarios need only six windows; range-loading tests request 3ms for 100 windows.
  experiment.execution = { ...experiment.execution, replications: 2, measurement: "300ms", window };
  experiment.faults = experiment.faults?.map(fault => ({ ...fault, from: "60ms", to: "210ms" }));
  await writeFile(resolve(directory, name), JSON.stringify(experiment));
  return experiment;
}
