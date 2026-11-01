import { expect, test } from "./fixtures";
import { selectExperiment } from "./fixtures";
import ru from "../src/i18n/ru.json" with { type: "json" };

test.use({ viewport: { width: 1440, height: 900 } });

for (const language of ["en", "ru"] as const) {
  test(`reveals checkout-grid run settings and aligns all fields in ${language}`, async ({ page }, testInfo) => {
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    await page.goto("/");
    await selectExperiment(page, "checkout/checkout-grid.experiment.json");
    const russian = language === "ru";
    const settings = page.getByRole("button", { name: russian ? "Настройки прогона" : "Run settings", exact: true });
    const inspector = page.getByRole("complementary", { name: russian ? "Инспектор" : "Inspector", exact: true });
    const heading = inspector.getByRole("heading", { name: russian ? "Настройки прогона" : "Run settings", exact: true });
    await expect(page.getByRole("button", { name: russian ? "Запустить" : "Run", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: russian ? "Свернуть инспектор" : "Collapse inspector", exact: true }).click();
    await expect(settings).toHaveAttribute("aria-pressed", "false");
    await settings.click();
    await expect(heading).toBeVisible();
    await expect(inspector.locator(".inspector-type").first()).toHaveText("checkout-grid");
    await expect(inspector.getByRole("heading", { name: russian ? "Прогон" : "Run", exact: true })).toBeVisible();
    await expect(inspector.getByRole("heading", { level: 3 })).toHaveText(russian
      ? ["Прогон", "Отказы", "Перебор параметров"] : ["Run", "Faults", "Parameter sweep"]);
    await expect(settings).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("rf__node-api-gateway").locator(".block-node > strong").click();
    await expect(inspector.getByRole("heading", { name: "api-gateway", exact: true })).toBeVisible();
    await expect(settings).toHaveAttribute("aria-pressed", "false");
    await settings.click();
    await expect(heading).toBeVisible();
    await expect(page.getByTestId("rf__node-api-gateway")).not.toHaveClass(/\bselected\b/);

    const inputs = inspector.locator(".inspector-execution .param-field > input");
    await expect(inputs).toHaveCount(6);
    const edges = await inputs.evaluateAll(inputs => inputs.map(input => {
      const { left, right } = input.getBoundingClientRect();
      return { left, right };
    }));
    for (const edge of edges) {
      expect(Math.abs(edge.left - edges[0].left)).toBeLessThanOrEqual(1);
      expect(Math.abs(edge.right - edges[0].right)).toBeLessThanOrEqual(1);
    }
    const seed = await inspector.getByRole("textbox", { name: russian ? "Начальное значение генератора" : "Seed", exact: true }).boundingBox();
    const random = await inspector.getByRole("button", { name: russian ? "Случайное начальное значение генератора" : "Random seed", exact: true }).boundingBox();
    expect(random!.x).toBeGreaterThan(seed!.x);
    expect(random!.x + random!.width).toBeLessThanOrEqual(seed!.x + seed!.width);
    await page.screenshot({ path: testInfo.outputPath(`run-settings-${language}.png`) });
    if (russian) {
      const fault = inspector.locator('[data-inspector-field="faults.0"]');
      await fault.getByRole("combobox", { name: ru["editor.fault.kind"], exact: true }).selectOption("blackhole");
      await expect(page.getByRole("button", { name: ru["app.topBar.run"], exact: true })).toBeEnabled();
      await fault.getByRole("button", { name: ru["help.more"].replace("{field}", ru["editor.fault.kind"]), exact: true }).click();
      await page.screenshot({ path: testInfo.outputPath("fault-blackhole-help-ru.png") });
    }
  });
}
