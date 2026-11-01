import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import ru from "../src/i18n/ru.json" with { type: "json" };
import { cleanupWorkspace, copyRetryStorm, expect, readWorkspaceDocument, selectExperiment, test } from "./fixtures";
import { dragConnection } from "./canvasGestures";

test.use({ viewport: { width: 1600, height: 1000 } });

test("a new block keeps its Russian display name after saving and reloading, and invalid identifiers stay local", async ({ page }, testInfo) => {
  const directory = `block-titles-${randomUUID()}`;
  const root = resolve("../apps/server/build/e2e-workspace", directory);
  await copyRetryStorm(root);
  const path = (kind: string) => `${directory}/retry-storm.${kind}.json`;
  const url = (kind: string) => `/api/v1/workspace/document?path=${encodeURIComponent(path(kind))}`;
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
  try {
    await page.goto("/");
    await selectExperiment(page, path("experiment"));
    await page.getByRole("complementary", { name: ru["editor.palette.label"], exact: true })
      .getByRole("button", { name: ru["catalog.types.client.title"], exact: true }).dblclick();
    const client = page.getByTestId("rf__node-client-1");
    await expect(client).toBeVisible();
    await page.locator(".react-flow__controls-fitview").click();
    await dragConnection(client.locator(".react-flow__handle.source"), page.getByTestId("rf__node-gateway").locator(".react-flow__handle.target"));
    const save = page.getByRole("button", { name: ru["app.topBar.save"], exact: true });
    await save.click();
    await expect(page.locator(".dirty-mark")).toBeHidden();
    const beforeModel = await readWorkspaceDocument(page.request, url("model"));
    const beforeLayout = await readWorkspaceDocument(page.request, url("layout"));
    const beforeExperiment = await readWorkspaceDocument(page.request, url("experiment"));

    await client.locator(".block-node-header").click();
    const title = page.getByRole("textbox", { name: ru["editor.block.title"], exact: true });
    const identifier = page.getByRole("textbox", { name: ru["editor.identifier"], exact: true });
    await title.fill("Мобильное приложение");
    await title.press("Tab");
    await expect(client.locator(".block-node-name")).toHaveText("Мобильное приложение");
    await expect(client.locator(".block-node-name")).toHaveAttribute("title", "client-1");
    await expect(identifier).toHaveValue("client-1");

    await identifier.fill("Мобильное приложение");
    await expect(identifier).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert").filter({ hasText: ru["editor.identifier.blockInvalid"] })).toBeVisible();
    await expect(page.getByRole("button", { name: ru["file.menu"], exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: ru["app.topBar.run"], exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("block-title-invalid-id-ru.png") });
    await title.click();
    await expect(identifier).toHaveValue("client-1");
    await expect(page.getByRole("status").filter({ hasText: "client-1" })).toBeVisible();
    await save.click();
    await expect(page.locator(".dirty-mark")).toBeHidden();

    const expected = structuredClone(beforeModel.content.model);
    expected.blocks["client-1"].title = "Мобильное приложение";
    expect((await readWorkspaceDocument(page.request, url("model"))).content.model).toEqual(expected);
    expect((await readWorkspaceDocument(page.request, url("layout"))).content.layout).toEqual(beforeLayout.content.layout);
    expect((await readWorkspaceDocument(page.request, url("experiment"))).content.experiment).toEqual(beforeExperiment.content.experiment);
    await page.reload();
    await client.locator(".block-node-header").click();
    await expect(title).toHaveValue("Мобильное приложение");
    await expect(identifier).toHaveValue("client-1");
    await expect(client.locator(".block-node-name")).toHaveText("Мобильное приложение");
    await expect(page.getByRole("button", { name: ru["app.topBar.run"], exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("block-title-saved-ru.png") });
  } finally {
    await cleanupWorkspace(page, root);
  }
});
