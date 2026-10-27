import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error('Usage: node browser.mjs measurements.json output.json');
const base = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const inputs = Array.isArray(manifest) ? manifest : manifest.measurements;
const bundle = await build({ entryPoints: [resolve(base, 'browser-entry.mjs')], bundle: true,
  format: 'iife', platform: 'browser', write: false });
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Results volume benchmark</title><script src="/bundle.js"></script>');
  } else if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle.outputFiles[0].contents);
  } else {
    const match = /^\/data\/(\d+)$/.exec(req.url);
    const input = match && inputs[Number(match[1])];
    if (!input) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    let options;
    if (range) {
      const start = Number(range[1]), end = Number(range[2]);
      if (start > end || end >= input.bytes) { res.writeHead(416).end(); return; }
      res.statusCode = 206;
      res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + input.bytes);
      res.setHeader('Content-Length', end - start + 1);
      options = { start, end };
    } else res.setHeader('Content-Length', input.bytes);
    createReadStream(input.path, options).on('error', e => res.destroy(e)).pipe(res);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const userAgent = await context.newPage().then(async p => {
    const value = await p.evaluate(() => navigator.userAgent);
    await p.close();
    return value;
  });
  for (let i = 0; i < inputs.length; i++) {
    const expected = inputs[i];
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.benchmark === 'function');
    const url = origin + '/data/' + i;
    const cold = await page.evaluate(([url, expected]) => window.benchmark(url, expected), [url, expected]);
    // Two untimed reader warmups on the same bytes/schema size, then three measured scans.
    for (let warmup = 0; warmup < 2; warmup++)
      await page.evaluate(([url, expected]) => window.benchmark(url, expected, false), [url, expected]);
    const trials = [];
    for (let trial = 0; trial < 3; trial++)
      trials.push(await page.evaluate(([url, expected]) => window.benchmark(url, expected, false), [url, expected]));
    let streaming = null;
    if (expected.format === 'arrow') {
      streaming = await page.evaluate(([url, expected]) => window.streamArrow(url, expected), [url, expected]);
      const verified = await page.evaluate(([url, expected]) => window.streamArrow(url, expected, true), [url, expected]);
      streaming.canonicalSha256 = verified.canonicalSha256;
    }
    let slice = null;
    if (expected.format === 'parquet' && expected.kind === 'series') {
      const args = [url, expected, cold.uiChecksum, cold.uiCanonicalSha256];
      slice = await page.evaluate(args => window.parquetSlice(...args), args);
      const verified = await page.evaluate(args => window.parquetSlice(...args, true), args);
      slice.canonicalSha256 = verified.canonicalSha256;
    }
    const record = { kind: expected.kind, format: expected.format, blocks: expected.blocks,
      windows: expected.windows, seed: expected.seed, bytes: expected.bytes,
      rows: expected.rows, cold, trials, streaming, slice };
    results.push(record);
    await writeFile(outputPath, JSON.stringify({ node: process.version, chromium: browser.version(), userAgent, results }, null, 2) + '\n');
    console.log(JSON.stringify({ format: expected.format, blocks: expected.blocks, kind: expected.kind,
      medianDecodeMs: trials.map(t => t.decodeAndScanMs).sort((a,b) => a-b)[1], rows: cold.rows }));
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
