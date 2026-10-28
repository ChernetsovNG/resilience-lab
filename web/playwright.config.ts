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

// Workers reload this config after the servers have started.
if (process.env.TEST_WORKER_INDEX === undefined) {
  await Promise.all([
    assertPortAvailable(backendPort, "E2E_BACKEND_PORT"),
    assertPortAvailable(webPort, "E2E_WEB_PORT"),
  ]);
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./playwright.global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: webURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: process.platform === "win32"
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
