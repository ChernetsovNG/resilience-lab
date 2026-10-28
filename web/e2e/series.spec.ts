import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { get, type IncomingHttpHeaders } from "node:http";
import { gunzipSync } from "node:zlib";
import type { JobView } from "../src/api/apiTypes";
import type { components } from "../src/api/schema";

test("browser decodes original gzip series through the same-origin proxy", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  const submitted = await request.post("/api/v1/jobs", {
    data: { experiment: "retry-storm/retry-storm.experiment.json" },
  });
  expect(submitted.status()).toBe(202);
  let job: JobView = await submitted.json();
  await expect.poll(async () => {
    job = await (await request.get(`/api/v1/jobs/${job.id}`)).json();
    return job.status;
  }, { timeout: 60_000 }).toMatch(/COMPLETED|FAILED/);
  expect(job.status).toBe("COMPLETED");
  const manifest: components["schemas"]["RunManifest"] =
    await (await request.get(`/api/v1/runs/${job.runId}/manifest`)).json();
  for (const variant of manifest.variants) {
    for (let rep = 0; rep < manifest.replications; rep++) {
      const route = `/api/v1/runs/${job.runId}/series/${variant}/p0/${rep}`;
      const indexResponse = await request.get(route);
      expect(indexResponse.status()).toBe(200);
      const index: components["schemas"]["SeriesIndex"] = await indexResponse.json();
      expect(index.parts.length).toBeGreaterThan(0);
      for (const reference of index.parts) {
        const part = reference.file.replace(/^part-(\d+)\.json\.gz$/, "$1");
        const url = new URL(`${route}/${part}`, page.url());
        const raw = await readRaw(url);
        expect(raw.headers["content-type"]).toBe("application/json");
        expect(raw.headers["content-encoding"]).toBe("gzip");
        expect(raw.headers.etag).toBe(`"${reference.sha256}"`);
        expect(raw.headers["cache-control"]).toContain("immutable");
        expect(createHash("sha256").update(raw.bytes).digest("hex")).toBe(reference.sha256);
        const decoded = gunzipSync(raw.bytes);
        expect(decoded.byteLength).toBe(reference.uncompressedBytes);
        const browserPart = await page.evaluate(async (address) => {
          const response = await fetch(address);
          if (!response.ok) throw new Error(`Series request failed: ${response.status}`);
          return response.json();
        }, url.toString());
        expect(browserPart).toEqual(JSON.parse(decoded.toString("utf8")));
      }
    }
  }
});

function readRaw(url: URL): Promise<{ bytes: Buffer; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "Accept-Encoding": "gzip" } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ bytes: Buffer.concat(chunks), headers: response.headers }));
    }).on("error", reject);
  });
}
