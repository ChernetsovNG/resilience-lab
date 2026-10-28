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
