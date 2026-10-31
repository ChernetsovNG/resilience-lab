import { expect, test } from "@playwright/test";
import { selectExperiment } from "./fixtures";

test.use({ locale: "ru-RU", viewport: { width: 1280, height: 800 }, actionTimeout: 15_000 });

test("checkout Timeline offers model elements and distinguishes compared variants", async ({ page }, testInfo) => {
  await page.goto("/");
  await selectExperiment(page, "checkout/checkout.experiment.json");
  await page.getByTestId("rf__node-psp").click();
  const completed = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()), { timeout: 90_000 });
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await completed;
  await expect(page.getByRole("table", { name: "Ответ", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Таймлайн", exact: true }).click();
  await page.getByLabel("Вариант для сравнения", { exact: true }).selectOption("no-order-retries");
  const queue = page.getByRole("region", { name: "Очередь", exact: true });
  await expect(queue.locator(".recharts-line-curve")).toHaveCount(2);
  const latency = page.getByRole("region", { name: "Задержка", exact: true });
  await expect(latency.locator("circle.timeline-latency-marker").first()).toBeVisible();
  await expect(latency.locator("rect.timeline-latency-marker--comparison").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("timeline-comparison.png") });
  await page.getByText("Элементы и показатели", { exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("timeline-choices.png") });

  const choices = page.locator(".timeline-choices");
  await expect(choices.getByRole("group")).toHaveCount(8);
  await expect(choices.getByRole("checkbox")).toHaveCount(21);
  const element = choices.getByRole("group", { name: "psp · Сервис", exact: true });
  await expect(element.getByRole("checkbox")).toHaveCount(14);
  await expect(element.getByRole("checkbox", { checked: true })).toHaveCount(6);
  await expect(choices.getByText(/пулер|маршрутизатор/i)).toHaveCount(0);
  const curves = queue.locator(".recharts-line-curve");
  const strokes = await curves.evaluateAll(lines => lines.map(line => line.getAttribute("stroke")));
  expect(new Set(strokes).size).toBe(2);
  await expect(queue.locator('.recharts-line-curve[stroke-dasharray="6 4"]')).toHaveCount(1);
  await expect(queue.locator(".timeline-readout")).toContainText("Baseline");
  await expect(queue.locator(".timeline-readout")).toContainText("No order retries");
  await expect(queue.locator(".timeline-readout")).not.toContainText("no-order-retries");
});
