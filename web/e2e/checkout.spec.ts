import { expect, test } from "@playwright/test";

const experiments = ["checkout/checkout.experiment.json", "checkout/checkout-grid.experiment.json"];

test.use({ viewport: { width: 1440, height: 900 } });

for (const experiment of experiments) {
  test(`${experiment} opens and validates without running the full experiment`, async ({ page, request }) => {
    await page.goto("/");
    const selector = page.getByLabel("Experiment", { exact: true });
    await expect(selector.locator("option", { hasText: experiment })).toHaveCount(1);
    await selector.selectOption(experiment);
    await expect(page.getByTestId("block-node")).toHaveCount(5);
    for (const node of ["mobile-app", "api-gateway", "order-service", "payment-service", "psp"]) {
      await expect(page.getByTestId(`rf__node-${node}`)).toBeInViewport({ ratio: 0.99 });
    }
    const response = await request.post("/api/v1/validate", { data: { experiment } });
    expect(response.ok()).toBe(true);
    const report = await response.json();
    expect(report.valid).toBe(true);
    expect(report.diagnostics.filter((diagnostic: { severity: string }) => diagnostic.severity === "ERROR")).toEqual([]);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });
}

test("opens Problems from a collapsed example and restores each tab's saved height", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("resilience-lab.results-panel-heights", JSON.stringify({
    "normal:answer": 200, "normal:problems": 320,
  })));
  await page.goto("/");
  await page.getByLabel("Experiment", { exact: true }).selectOption("checkout/checkout-grid.experiment.json");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toBeHidden();

  const problems = page.getByRole("tab", { name: "Problems", exact: true });
  await problems.click();
  await expect(problems).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".validation-problems").getByRole("listitem").first()).toBeVisible();
  const divider = page.getByRole("separator", { name: "Resize results panel" });
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
  await problems.click();
  await expect(panel).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "320");

  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await page.getByRole("tab", { name: "Answer", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "200");
  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await problems.click();
  await expect(panel).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
});
