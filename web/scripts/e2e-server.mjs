import { spawnSync } from "node:child_process";
import { accessSync, cpSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const jar = resolve(process.env.E2E_SERVER_JAR);
accessSync(jar);
const workspace = resolve("apps/server/build/e2e-workspace");
rmSync(workspace, { recursive: true, force: true });
cpSync("examples", workspace, {
  recursive: true,
  filter: (source) => basename(source) !== ".results",
});

const result = spawnSync("java", [
  "-jar", jar,
  `--resilience-lab.workspace=${workspace}`,
  `--server.port=${process.env.E2E_BACKEND_PORT ?? "8080"}`,
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
