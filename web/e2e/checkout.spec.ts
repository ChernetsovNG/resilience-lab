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
