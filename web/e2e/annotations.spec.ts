import { randomUUID } from "node:crypto";
import { cp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, selectExperiment, test, type Page } from "./fixtures";
import type { ExperimentFile, LayoutFile, ModelFile } from "../src/api/apiTypes";

test.use({ viewport: { width: 1600, height: 1000 } });

async function stored(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).content;
}

async function openSection(page: Page, selector: string) {
  const section = page.locator(selector);
  if (await section.getAttribute("open") === null) await section.locator("summary").first().click();
  return section;
}

test("checkout-replicas explanations survive editing, saving and reloading in Russian", async ({ page }, testInfo) => {
  const directory = `annotations-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  await cp(resolve("../examples/checkout-replicas"), target, { recursive: true });
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
  const path = (kind: string) => `${directory}/checkout-replicas.${kind}.json`;
  try {
    await page.goto("/");
    await selectExperiment(page, path("experiment"));
    const beforeModel: ModelFile = (await stored(page, path("model"))).model;
    const beforeExperiment: ExperimentFile = (await stored(page, path("experiment"))).experiment;
    const beforeLayout: LayoutFile = (await stored(page, path("layout"))).layout;
    const sourceModel: ModelFile = JSON.parse(await readFile(resolve(target, "checkout-replicas.model.json"), "utf8"));
    const sourceExperiment: ExperimentFile = JSON.parse(await readFile(resolve(target, "checkout-replicas.experiment.json"), "utf8"));
    const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });
    const description = "  Три реплики оформления заказа.\nОбщий сценарий, отдельный пул каждой реплики.  ";
    const variantDescription = "  Повтор выбирает другую реплику.\nДопущение: независимые пулы.  ";
    const notes = `${sourceExperiment.notes}\n\n  Источник допущения: https://example.org/model  `;

    await page.getByRole("tab", { name: "Модель", exact: true }).click();
    await page.locator(".react-flow__controls-fitview").click();
    await page.getByTestId("rf__node-order-service").locator(".block-node-header").click();
    await openSection(page, ".inspector-parameters");
    await expect(inspector.getByRole("textbox", { name: "Заметки", exact: true })).toHaveValue(sourceModel.blocks["order-service"].notes!);
    await inspector.getByRole("textbox", { name: "Описание", exact: true }).fill(description);
    await inspector.getByRole("textbox", { name: "Описание", exact: true }).press("Tab");
    await page.getByTestId("rf__node-order-service").getByRole("button", { name: "Подробнее: order-service", exact: true }).click();
    await expect(page.getByRole("tooltip")).toHaveText(description);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("annotations-element-ru.png") });

    await page.getByTestId("canvas-edge-label-order-service-to-pgbouncer").click();
    await expect(inspector.getByRole("textbox", { name: "Заметки", exact: true }))
      .toHaveValue(sourceModel.connections.find(connection => connection.id === "order-service-to-pgbouncer")!.notes!);
    await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
    const annotations = await openSection(page, ".inspector-annotations");
    const modelFields = annotations.getByRole("group", { name: "Модель", exact: true });
    const experimentFields = annotations.getByRole("group", { name: "Эксперимент", exact: true });
    await expect(modelFields.getByRole("textbox", { name: "Описание", exact: true })).toHaveValue(sourceModel.description!);
    await expect(modelFields.getByRole("textbox", { name: "Заметки", exact: true })).toHaveValue(sourceModel.notes!);
    await expect(experimentFields.getByRole("textbox", { name: "Описание", exact: true })).toHaveValue(sourceExperiment.description!);
    await expect(experimentFields.getByRole("textbox", { name: "Заметки", exact: true })).toHaveValue(sourceExperiment.notes!);
    await experimentFields.getByRole("textbox", { name: "Заметки", exact: true }).fill(notes);
    await experimentFields.getByRole("textbox", { name: "Заметки", exact: true }).press("Tab");
    await annotations.scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("annotations-run-settings-ru.png") });

    const variant = page.getByRole("tab", { name: "Другая реплика", exact: true });
    await variant.click();
    await variant.click();
    await inspector.getByRole("textbox", { name: "Описание", exact: true }).fill(variantDescription);
    await inspector.getByRole("textbox", { name: "Описание", exact: true }).press("Tab");
    await expect(variant).toHaveAttribute("title", new RegExp("Повтор выбирает другую реплику"));
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("annotations-variant-ru.png") });
    await page.getByTestId("rf__node-order-service").locator(".block-node-header").click();
    await openSection(page, ".inspector-parameters");
    await expect(inspector.getByRole("textbox", { name: "Описание", exact: true })).toHaveAttribute("readonly", "");
    await expect(inspector.getByRole("textbox", { name: "Описание", exact: true })).toHaveValue(description);

    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
    const expectedModel = structuredClone(beforeModel);
    expectedModel.blocks["order-service"].description = description;
    const expectedExperiment = structuredClone(beforeExperiment);
    expectedExperiment.notes = notes;
    expectedExperiment.variants.find(variant => variant.id === "other-replica")!.description = variantDescription;
    expect((await stored(page, path("model"))).model).toEqual(expectedModel);
    expect((await stored(page, path("experiment"))).experiment).toEqual(expectedExperiment);
    expect((await stored(page, path("layout"))).layout).toEqual(beforeLayout);

    await page.reload();
    await variant.click();
    await variant.click();
    await expect(inspector.getByRole("textbox", { name: "Описание", exact: true })).toHaveValue(variantDescription);
    await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
    await openSection(page, ".inspector-annotations");
    await expect(experimentFields.getByRole("textbox", { name: "Заметки", exact: true })).toHaveValue(notes);
    await page.getByRole("tab", { name: "Модель", exact: true }).click();
    await page.getByTestId("rf__node-order-service").locator(".block-node-header").click();
    await openSection(page, ".inspector-parameters");
    await expect(inspector.getByRole("textbox", { name: "Описание", exact: true })).toHaveValue(description);
    const savedModel = JSON.parse(await readFile(resolve(target, "checkout-replicas.model.json"), "utf8"));
    expect(savedModel.blocks["order-service"].notes).toBe(sourceModel.blocks["order-service"].notes);
    expect(savedModel.notes).toBe(sourceModel.notes);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
