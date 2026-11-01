import { defineConfig } from "@playwright/test";
import { createServer } from "node:net";

function e2ePort(variable: string, fallback: number): number {
  const port = Number(process.env[variable] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variable} must be an integer between 1 and 65535.`);
  }
  return port;
}

async function assertPortAvailable(port: number, variable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", (cause) => reject(new Error(
      `E2E port ${port} is unavailable. Set ${variable} to a free port.`,
      { cause },
    )));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

const backendPort = e2ePort("E2E_BACKEND_PORT", 8080);
const webPort = e2ePort("E2E_WEB_PORT", 5173);
const webURL = `http://127.0.0.1:${webPort}`;

if (backendPort === webPort) {
  throw new Error("E2E_BACKEND_PORT and E2E_WEB_PORT must use different ports.");
}

// Check once per launch: workers and UI mode reload this config after the servers have started,
// and they inherit or share this process environment.
if (process.env.E2E_PORTS_CHECKED === undefined) {
  await Promise.all([
    assertPortAvailable(backendPort, "E2E_BACKEND_PORT"),
    assertPortAvailable(webPort, "E2E_WEB_PORT"),
  ]);
  process.env.E2E_PORTS_CHECKED = "1";
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./playwright.global-setup.ts",
  // Shards split individual tests, not whole files; each shard still runs them one at a time on its own backend.
  fullyParallel: true,
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: webURL,
    locale: "en-US",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: process.env.E2E_SERVER_JAR
        ? "node web/scripts/e2e-server.mjs"
        : process.platform === "win32"
          ? "gradlew.bat :apps:server:bootRunE2e"
          : "./gradlew :apps:server:bootRunE2e",
      cwd: "..",
      name: `backend (E2E_BACKEND_PORT=${backendPort})`,
      env: { E2E_BACKEND_PORT: String(backendPort) },
      wait: { stdout: /Started ResilienceLabApplicationKt in [\d.]+ seconds/ },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --mode e2e --host 127.0.0.1 --port ${webPort} --strictPort`,
      name: `web (E2E_WEB_PORT=${webPort})`,
      env: { E2E_BACKEND_PORT: String(backendPort) },
      wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${webPort}/`) },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
