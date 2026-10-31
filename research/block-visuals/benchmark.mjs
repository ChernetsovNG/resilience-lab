import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
const port = Number(process.env.BENCH_PORT || 15246),
  base = `http://127.0.0.1:${port}`;
const repeats = Number(process.env.BENCH_REPEATS || 3),
  warmupMs = Number(process.env.BENCH_WARMUP_MS || 2000),
  durationMs = Number(process.env.BENCH_DURATION_MS || 4000);
const variants = [
  ...[
    "parametric",
    "stencil",
    "fixed-svg",
    "react-icon",
    "symbol",
    "font",
    "canvas2d",
    "webgl",
  ].map((mode) => ({ mode, cull: false })),
  { mode: "parametric", cull: true },
];
const cases = [50, 500, 5000].flatMap((n) =>
  variants.map((v) => ({ ...v, n })),
);
const selected = process.env.BENCH_FILTER
  ? cases.filter((c) =>
      `${c.mode}:${c.n}:${c.cull}`.includes(process.env.BENCH_FILTER),
    )
  : cases;
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { stdio: "pipe" },
);
let serverLog = "";
server.stdout.on("data", (x) => (serverLog += x));
server.stderr.on("data", (x) => (serverLog += x));
const raw = [];
let browser;
const quantile = (a, p) =>
  [...a].sort((x, y) => x - y)[Math.ceil(a.length * p) - 1];
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error(serverLog);
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const sourceSha256 = Object.fromEntries(
    await Promise.all(
      [
        "src.jsx",
        "style.css",
        "index.html",
        "benchmark.mjs",
        "package-lock.json",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
  const installedVersions = Object.fromEntries(
    await Promise.all(
      [
        "react",
        "react-dom",
        "@xyflow/react",
        "vite",
        "playwright",
        "@fortawesome/fontawesome-free",
      ].map(async (name) => [
        name,
        JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"))
          .version,
      ]),
    ),
  );
  const metadata = {
    sourceSha256,
    installedVersions,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
    browser: browser.version(),
    executable: chromium.executablePath().replace(os.homedir(), "~"),
    headless: true,
    launchFlags: [],
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    repeats,
    warmupMs,
    durationMs,
    cases: selected,
    dependencies: JSON.parse(await readFile("package.json", "utf8")),
    timingScope:
      "bootstrap script before dynamic module fetch/evaluation and renderer/data initialization; wait nodes initialized or canvas setup, fonts ready, 2 requestAnimationFrame; excludes HTML navigation before bootstrap, not compositor-paint measurement. Every sample fresh browser context and HTTP cache; shared browser/OS filesystem cache remains warm. All modes load same common application bundle including React Flow. Frame loop elapsed-time bounded, viewport .05 to 2 to .05 about scene center, no screenshots in timer.",
    workload:
      "deterministic ceil(sqrt(N)) grid at 244x172; 6 own types mixed round-robin; widths 180/192/204, heights126/136; label, capacity row, p99/heat row, six heat fills, override/selection marks, two ports; N-1 straight edges. ReactFlow has real input/handles/interactions; Canvas/WebGL cache six raster atlas tiles and lack editing/a11y/ReactFlow semantics. No visual equivalence claim for font glyphs vs own icons.",
  };
  await mkdir("results", { recursive: true });
  for (let rep = 0; rep < repeats; rep++) {
    const rotation = (rep * 11) % selected.length;
    const order = [...selected.slice(rotation), ...selected.slice(0, rotation)];
    for (const item of order) {
      const context = await browser.newContext({
        viewport: metadata.viewport,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const url = `${base}/?mode=${item.mode}&n=${item.n}&cull=${Number(item.cull)}`;
      const start = performance.now();
      await page.goto(url, { waitUntil: "load" });
      await page.waitForFunction(() => window.benchReady === true, null, {
        timeout: 120000,
      });
      const navigationReadyMs = performance.now() - start;
      const measurement = await page.evaluate(
        (options) => window.bench.run(options),
        { warmupMs, durationMs },
      );
      if (errors.length) throw Error(JSON.stringify({ item, errors }));
      const row = { rep, ...item, navigationReadyMs, ...measurement };
      raw.push(row);
      await writeFile(
        "results/raw.json",
        JSON.stringify({ metadata, samples: raw }, null, 2) + "\n",
      );
      console.log(
        JSON.stringify({
          rep,
          ...item,
          ready: Math.round(row.firstReadyMs),
          fps: +row.fps.toFixed(1),
          p95: +row.p95FrameGapMs.toFixed(1),
          dom: row.initialDom,
          renderer: row.rendererInfo?.renderer,
        }),
      );
      if (
        rep === 0 &&
        item.n === 50 &&
        [
          "parametric",
          "stencil",
          "fixed-svg",
          "react-icon",
          "font",
          "canvas2d",
          "webgl",
        ].includes(item.mode) &&
        !item.cull
      ) {
        await page.evaluate(() => window.benchPreview?.());
        await page.screenshot({ path: `/tmp/issue-346-${item.mode}.png` });
      }
      await context.close();
    }
  }
  const summary = selected.map((item) => {
    const trials = raw.filter(
      (r) => r.mode === item.mode && r.n === item.n && r.cull === item.cull,
    );
    return {
      ...item,
      samples: trials.length,
      medianReadyMs: quantile(
        trials.map((t) => t.firstReadyMs),
        0.5,
      ),
      medianFps: quantile(
        trials.map((t) => t.fps),
        0.5,
      ),
      medianP95GapMs: quantile(
        trials.map((t) => t.p95FrameGapMs),
        0.5,
      ),
      pooledP95GapMs: quantile(
        trials.flatMap((t) => t.frameGapsMs),
        0.95,
      ),
      initialDom: trials[0].initialDom,
      visibleSamples: trials[0].visibleSamples,
      realizedZoomRanges: trials.map((t) => t.realizedZoomRange),
    };
  });
  await writeFile(
    "results/summary.json",
    JSON.stringify({ metadata, summary }, null, 2) + "\n",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
