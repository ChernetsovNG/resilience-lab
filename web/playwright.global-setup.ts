import { request } from "@playwright/test";
import type { FullConfig } from "@playwright/test";

/** Checks HTTP readiness only after both launched processes reported startup. */
export default async function waitForServers(config: FullConfig): Promise<void> {
  const backendURL = `http://127.0.0.1:${Number(process.env.E2E_BACKEND_PORT ?? "8080")}`;
  const webURL = config.projects[0].use.baseURL!;
  const context = await request.newContext();
  try {
    for (const url of [`${backendURL}/api/v1/health`, webURL, `${webURL}/api/v1/health`]) {
      const response = await context.get(url);
      if (!response.ok()) {
        throw new Error(`E2E server is not ready: ${url} returned HTTP ${response.status()}.`);
      }
    }
  } finally {
    await context.dispose();
  }
}
