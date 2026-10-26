import { expect, test } from "@playwright/test";

test("runs a two-value link timeout sweep and plots both points", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await page.getByRole("button", { name: "New three-service chain" }).click();
  await page.getByLabel("Replications", { exact: true }).fill("2");
  await page.getByLabel("Warm-up (ms)", { exact: true }).fill("0");
  await page.getByLabel("Measurement (ms)", { exact: true }).fill("50");
  await page.getByLabel("Maximum real time (seconds)", { exact: true }).fill("1");

  await page.getByLabel("Sweep parameter", { exact: true }).selectOption("LINK_TIMEOUT");
  await page.getByLabel("Link ID", { exact: true }).fill("link-1");
  await page.getByLabel("Sweep values", { exact: true }).fill("25, 50");
  await page.getByRole("button", { name: "Apply sweep" }).click();
  await page.getByRole("button", { name: "Run sweep", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });

  const chart = page.getByRole("figure", { name: "Parameter sweep" });
  const points = chart.locator("figcaption").getByRole("listitem");
  await expect(chart).toBeVisible();
  await expect(points).toHaveCount(2);
  await expect(points.nth(0)).toContainText("25:");
  await expect(points.nth(1)).toContainText("50:");
  await expect(chart.locator(".recharts-line-dots circle")).toHaveCount(2);
});
