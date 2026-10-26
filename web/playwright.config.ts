import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: process.platform === "win32"
        ? "gradlew.bat :apps:server:bootRun"
        : "./gradlew :apps:server:bootRun",
      cwd: "..",
      url: "http://127.0.0.1:8080/api/v1/health",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
