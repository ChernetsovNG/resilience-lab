import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node run.mjs ../build/output');
const output = resolve(directory);
const base = fileURLToPath(new URL('.', import.meta.url));
const routes = new Map([['/', {
  type: 'text/html',
  data: '<!doctype html><meta charset="utf-8"><title>Latency sketch benchmark</title><script type="module">import { run } from "/benchmark.js"; window.run = run;</script>',
}]]);
for (const name of ['benchmark.js', 'checks.js', 'sketch.js']) {
  routes.set(`/${name}`, { type: 'text/javascript', data: await readFile(resolve(base, 'dist', name)) });
}
const inputBytes = {};
for (const name of ['fixtures.json', 'selected-ui.json', 'selected-ui.json.gz']) {
  const data = await readFile(resolve(output, name));
  inputBytes[name] = data.byteLength;
  routes.set(`/${name}`, { type: 'application/octet-stream', data });
}
const server = createServer((request, response) => {
  const route = routes.get(request.url);
  if (!route) { response.writeHead(404).end(); return; }
  response.writeHead(200, {
    'Content-Type': route.type,
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  response.end(route.data);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.run === 'function');
  const measurements = await page.evaluate(() => window.run());
  const result = { node: process.version, chromium: browser.version(), inputBytes, ...measurements };
  await writeFile(resolve(output, 'browser-measurements.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ node: result.node, chromium: result.chromium, fixtureCases: result.fixtureCases,
    json: result.json.summaryMs, gzip: result.gzip.summaryMs }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
