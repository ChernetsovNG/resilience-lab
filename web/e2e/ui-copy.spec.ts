import { expect, test } from "./fixtures";
import { selectExperiment } from "./fixtures";

test.use({ viewport: { width: 1280, height: 800 }, locale: "ru-RU" });

test("Russian toolbar stays readable and model switching names all three confirmation actions", async ({ page }, testInfo) => {
  const nativeDialogs: string[] = [];
  page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  const handlers = page.getByRole("complementary", { name: "Инспектор", exact: true }).getByRole("textbox", { name: "Обработчики", exact: true });
  await handlers.fill("5");
  await handlers.press("Tab");
  await expect(page.getByText("Несохранённые изменения", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Resilience Lab", exact: true })).toBeVisible();
  expect(await page.locator(".top-bar h1, .top-bar button, .dirty-mark").evaluateAll(elements => elements.flatMap(element => {
    const rect = element.getBoundingClientRect();
    return element.scrollWidth > element.clientWidth || rect.left < 0 || rect.right > innerWidth
      ? [element.textContent?.trim()] : [];
  }))).toEqual([]);
  expect(await page.getByRole("combobox", { name: "Эксперимент", exact: true }).locator("option:checked").textContent()).not.toContain(".experiment.json");
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("after-toolbar-ru.png"), scale: "css" });

  const model = page.getByRole("combobox", { name: "Модель", exact: true });
  await model.selectOption("checkout/checkout.model.json");
  const dialog = page.getByRole("dialog", { name: "Несохранённые изменения", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Сохранить изменения перед переходом?", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button")).toHaveText(["Отмена", "Не сохранять", "Сохранить и перейти"]);
  await expect(dialog.getByRole("button", { name: "Отмена", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("after-confirmation-ru.png"), scale: "css" });
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(model).toHaveValue("retry-storm/retry-storm.model.json");
  await expect(handlers).toHaveValue("5");
  await model.selectOption("checkout/checkout.model.json");
  await dialog.getByRole("button", { name: "Не сохранять", exact: true }).click();
  await expect(model).toHaveValue("checkout/checkout.model.json");
  await expect(dialog).toHaveCount(0);
  expect(nativeDialogs).toEqual([]);
});
