import { expect, test } from "./fixtures";
import { selectExperiment } from "./fixtures";
import en from "../src/i18n/en.json" with { type: "json" };
import ru from "../src/i18n/ru.json" with { type: "json" };
import { expectReadableFocus } from "./canvasAssertions";

for (const locale of ["en-US", "ru-RU"]) {
  test.describe(`slot saturation (${locale})`, () => {
    test.use({ locale });
    const messages = locale === "ru-RU" ? ru : en;
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) test(`Findings names the connection pool at ${viewport.width}px`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      const name = `slot-saturation-${locale}-${viewport.width}`;
      const model = { schemaVersion: 7, blocks: {
        client: { type: "client", params: { load: { points: [{ time: "0ms", rate: "300/s" }] }, deadline: "10s" } },
        gateway: { type: "service", params: { handlers: 100, queue: 1000, processing: { kind: "fixed", mean: "0ms" } } },
        "orders-db": { type: "database", params: { maxConnections: 100, queue: 1000, processing: { kind: "fixed", mean: "200ms" } } },
      }, connections: [
        { id: "request", type: "request", from: "client", to: "gateway" },
        { id: "to-db", type: "call", from: "gateway", to: "orders-db", params: {
          timeout: "10s", attempts: 1, pool: { size: 1, acquireTimeout: "10s" },
        } },
      ] };
      const experiment = { schemaVersion: 4, modelRef: `${name}.model.json`,
        execution: { replications: 2, seed: 42, warmup: "0ms", measurement: "300ms", window: "50ms" },
        variants: [{ id: "baseline", label: "Baseline" }] };
      expect((await request.put(`/api/v1/workspace/document?path=${name}.model.json`, { data: { model } })).ok()).toBe(true);
      expect((await request.put(`/api/v1/workspace/document?path=${name}.experiment.json`, { data: { experiment } })).ok()).toBe(true);
      await page.goto("/");
      await selectExperiment(page, `${name}.experiment.json`);
      await page.getByRole("button", { name: messages["app.topBar.run"], exact: true }).click();
      const insight = page.getByRole("region", { name: messages["results.saturation.title"], exact: true });
      const resource = `${locale === "ru-RU" ? "пул соединений" : "connection pool"} gateway → orders-db`;
      await expect(insight.locator(".saturation-insight > p").first()).toContainText(resource);
      await insight.locator(".saturation-insight > p").first().getByRole("button").click();
      const pool = page.getByTestId("canvas-edge-label-to-db");
      await expect(pool).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a))
        .toBeGreaterThanOrEqual(0.7);
      await expectReadableFocus(pool);
      await insight.getByText(messages["results.saturation.degradationPaths"], { exact: true }).click();
      await expect(insight.locator("li").first()).toContainText(resource);
    });
  });
}
