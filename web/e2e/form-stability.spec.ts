import { expect, test } from "./fixtures";
import { selectExperiment } from "./fixtures";

test.use({ viewport: { width: 1280, height: 800 }, locale: "ru-RU" });

test("keeps inspector and toolbar controls still when delayed lint warnings arrive and disappear", async ({ page }, testInfo) => {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await page.getByTestId("canvas-edge-label-gateway-to-middle").click();
  const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });
  const timeout = inspector.locator('[data-inspector-field="timeout"] input');
  const controls = page.locator(".top-bar :is(button, input, select), .inspector :is(input, select, button):not(.field-feedback *), .inspector-toggle");
  const positions = () => controls.evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));

  let initial: Awaited<ReturnType<typeof positions>> | undefined;
  for (const value of ["10ms", "500ms"]) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/validate", async route => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    const requested = page.waitForRequest("**/api/v1/validate");
    await timeout.fill(value);
    await timeout.press("Enter");
    await requested;
    const before = await positions();
    initial ??= before;
    expect(before).toEqual(initial);
    await page.screenshot({ path: testInfo.outputPath(value === "10ms" ? "before-warning.png" : "before-clear.png") });
    const responded = page.waitForResponse("**/api/v1/validate");
    release();
    await responded;
    if (value === "10ms") await expect(inspector.locator(".field-diagnostics")).toContainText("LINT_TIMEOUT_BUDGET");
    else await expect(inspector.locator(".field-diagnostics")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(value === "10ms" ? "with-warning.png" : "without-warning.png") });
    expect(await positions()).toEqual(before);
    if (value === "10ms") {
      await timeout.locator("..").locator(".field-feedback button").press("Enter");
      await expect(inspector.getByRole("tooltip")).toContainText("LINT_TIMEOUT_BUDGET");
      await page.screenshot({ path: testInfo.outputPath("warning-details.png") });
      await page.keyboard.press("Escape");
      expect(await positions()).toEqual(before);
    }
    await page.unroute("**/api/v1/validate");
  }
});

test("a double click on Add variant creates and selects one variant", async ({ page }) => {
  await page.goto("/");
  await selectExperiment(page, "checkout/checkout.experiment.json");
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  const tabs = page.locator(".variant-tabs").getByRole("tab");
  const count = await tabs.count();
  const add = page.getByRole("button", { name: "Добавить вариант", exact: true });
  await add.dblclick();
  // The first click inserts a tab before +; also exercise a second activation targeted at + itself.
  await add.dispatchEvent("click", { detail: 2 });
  await expect(tabs).toHaveCount(count + 1);
  await expect(page.getByRole("tab", { name: "Вариант 1", exact: true })).toHaveAttribute("aria-selected", "true");
});
