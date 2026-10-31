import { expect, selectExperiment, test } from "./fixtures";

for (const locale of ["en-US", "ru-RU"]) {
  test.describe(locale, () => {
    test.use({ locale });

    for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      test(`toolbar keeps labels readable and main actions together at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.goto("/");
        await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
        const replications = page.getByRole("textbox", { name: /^(Replications|Повторения)$/ });
        await replications.fill(String(Number(await replications.inputValue()) + 1));
        await replications.press("Tab");
        await expect(page.locator(".dirty-mark")).toBeVisible();
        await expect(page.getByRole("button", { name: /^(Run|Запустить)$/ })).toBeEnabled();

        const layout = await page.locator(".top-bar").evaluate(bar => {
          const controls = [...bar.querySelectorAll<HTMLElement>("h1, button, select, .dirty-mark, .top-bar-label")]
            .map(element => ({ element, rect: element.getBoundingClientRect(),
              name: element.getAttribute("aria-label") ?? element.textContent?.trim() }))
            .filter(({ rect }) => rect.width > 0 && rect.height > 0);
          const style = getComputedStyle(bar);
          const actions = controls.filter(({ name }) => /^(Save|Estimate|Run|Сохранить|Оценка|Запустить)$/.test(name ?? ""));
          return {
            height: bar.getBoundingClientRect().height,
            gap: parseFloat(style.columnGap),
            actionSpacing: actions.slice(1).map(({ rect }, index) => ({
              horizontal: rect.left - actions[index].rect.right,
              vertical: Math.abs(rect.top - actions[index].rect.top),
            })),
            singleRowHeight: Math.max(...controls.map(({ rect }) => rect.height)) +
              parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
              parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
            truncated: controls.filter(({ element }) => !(element instanceof HTMLSelectElement) &&
              element.scrollWidth > element.clientWidth).map(({ name }) => name),
            outside: controls.filter(({ rect }) => rect.left < 0 || rect.right > innerWidth).map(({ name }) => name),
          };
        });
        expect(layout.truncated).toEqual([]);
        expect(layout.outside).toEqual([]);
        expect(layout.actionSpacing).toHaveLength(2);
        for (const spacing of layout.actionSpacing) {
          expect(spacing.vertical).toBeLessThanOrEqual(1);
          expect(spacing.horizontal).toBeLessThanOrEqual(layout.gap + 1);
        }
        if (viewport.width >= 1440) expect(layout.height).toBeLessThanOrEqual(layout.singleRowHeight + 1);
        await page.screenshot({ path: testInfo.outputPath("toolbar.png"), scale: "css" });
      });
    }
  });
}
