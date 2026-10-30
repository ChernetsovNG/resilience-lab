import { expect, test } from "@playwright/test";
import { selectExperiment } from "./fixtures";

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
      ? ["Прогон", "Отказы", "Перебор"] : ["Run", "Faults", "Parameter grid"]);
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
  });
}
