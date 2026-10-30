import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  optimizeDeps: { include: ["recharts"] },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${mode === "e2e" ? process.env.E2E_BACKEND_PORT ?? "8080" : "8080"}`,
    },
  },
  test: {
    // App tests render the whole application in jsdom. Parallel files share the CI runner's CPU,
    // so an individual test can exceed Vitest's default 5 s.
    testTimeout: 15_000,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**"],
      reporter: ["text", "html", "lcov"],
      reportOnFailure: true,
    },
  },
}));
