import { expect, test } from "./fixtures";
import { selectExperiment } from "./fixtures";

for (const locale of ["en-US", "ru-RU"]) {
  test.describe(`slot saturation (${locale})`, () => {
    test.use({ locale });
    test("Findings names the connection pool from a real run", async ({ page, request }) => {
      const name = `slot-saturation-${locale}`;
      const model = { schemaVersion: 6, blocks: {
        client: { type: "client", params: { load: { points: [{ time: "0ms", rate: "300/s" }] }, deadline: "10s" } },
        gateway: { type: "service", params: { handlers: 100, queue: 1000, processing: { kind: "fixed", mean: "0ms" } } },
        "orders-db": { type: "database", params: { maxConnections: 100, queue: 1000, processing: { kind: "fixed", mean: "200ms" } } },
      }, connections: [
        { id: "request", type: "request", from: "client", to: "gateway" },
        { id: "to-db", type: "call", from: "gateway", to: "orders-db", params: {
          timeout: "10s", attempts: 1, pool: { size: 1, acquireTimeout: "10s" },
        } },
      ] };
      const experiment = { schemaVersion: 3, modelRef: `${name}.model.json`,
        execution: { replications: 2, seed: 42, warmup: "0ms", measurement: "300ms", window: "50ms" },
        variants: [{ id: "baseline", label: "Baseline" }] };
      expect((await request.put(`/api/v1/workspace/document?path=${name}.model.json`, { data: { model } })).ok()).toBe(true);
      expect((await request.put(`/api/v1/workspace/document?path=${name}.experiment.json`, { data: { experiment } })).ok()).toBe(true);
      await page.goto("/");
      await selectExperiment(page, `${name}.experiment.json`);
      await page.getByRole("button", { name: locale === "ru-RU" ? "Запустить" : "Run", exact: true }).click();
      const insight = page.getByRole("region", { name: locale === "ru-RU" ? "Вывод о насыщении" : "Saturation insight", exact: true });
      const resource = `${locale === "ru-RU" ? "пул соединений" : "connection pool"} gateway → orders-db`;
      await expect(insight.locator(".saturation-insight > p").first()).toContainText(resource);
      await insight.locator(".saturation-insight > p").first().getByRole("button").click();
      const pool = page.getByTestId("canvas-edge-label-to-db");
      await expect(pool).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a))
        .toBeGreaterThanOrEqual(0.7);
      await expect(pool).toBeInViewport({ ratio: 1 });
      await expect.poll(async () => {
        const target = (await pool.boundingBox())!;
        const canvas = (await page.locator(".react-flow").boundingBox())!;
        const banner = (await page.getByTestId("variant-banner").boundingBox())!;
        const course = await page.locator(".course-expanded").boundingBox();
        return Math.max(Math.abs(target.x + target.width / 2 - canvas.x - canvas.width / 2),
          Math.abs(target.y + target.height / 2 - canvas.y - (banner.height + 16 + canvas.height - (course?.height ?? 0)) / 2));
      }).toBeLessThan(1);
      await insight.getByText(locale === "ru-RU" ? "Пути деградации" : "Degradation paths", { exact: true }).click();
      await expect(insight.locator("li").first()).toContainText(resource);
    });
  });
}
