import { expect, test } from "@playwright/test";

test("does not submit the last valid value while an invalid draft is visible", async ({ page }) => {
  const experimentPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/experiments")) {
      experimentPosts.push(request.postData() ?? "");
    }
  });
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await page.getByLabel("Replications", { exact: true }).fill("");
  const run = page.getByRole("button", { name: "Run comparison", exact: true });
  await expect(page.getByLabel("Replications", { exact: true })).toHaveValue("");
  const disabled = await run.isDisabled();

  await run.evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
    button.click();
  });
  await page.waitForTimeout(250);
  expect(experimentPosts).toEqual([]);
  expect(disabled).toBe(true);
});
