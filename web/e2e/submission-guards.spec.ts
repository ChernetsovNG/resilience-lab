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

test("does not submit an applied sweep while a different valid draft is visible", async ({ page }) => {
  const experimentPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/experiments")) {
      experimentPosts.push(request.postData() ?? "");
    }
  });
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await page.getByLabel("Sweep parameter", { exact: true }).selectOption("LINK_TIMEOUT");
  await page.getByLabel("Link ID", { exact: true }).fill("link-1");
  await page.getByLabel("Sweep values", { exact: true }).fill("25, 50");
  await page.getByRole("button", { name: "Apply sweep" }).click();
  const run = page.getByRole("button", { name: "Run sweep", exact: true });
  await expect(run).toBeEnabled();
  await page.getByLabel("Sweep values", { exact: true }).fill("25, 75");
  const disabled = await run.isDisabled();

  await run.evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
    button.click();
  });
  await page.waitForTimeout(250);
  expect(experimentPosts).toEqual([]);
  expect(disabled).toBe(true);
});

test("does not submit an applied sweep while an invalid draft is visible", async ({ page }) => {
  const experimentPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/experiments")) {
      experimentPosts.push(request.postData() ?? "");
    }
  });
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await page.getByLabel("Sweep values", { exact: true }).fill("25, 50");
  await page.getByRole("button", { name: "Apply sweep" }).click();
  const run = page.getByRole("button", { name: "Run sweep", exact: true });
  await expect(run).toBeEnabled();
  await page.getByLabel("Sweep values", { exact: true }).fill("25, Infinity");
  await page.getByRole("button", { name: "Apply sweep" }).click();
  await expect(page.getByRole("alert")).toContainText("finite numbers");
  const disabled = await run.isDisabled();

  await run.evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
    button.click();
  });
  await page.waitForTimeout(250);
  expect(experimentPosts).toEqual([]);
  expect(disabled).toBe(true);
});
