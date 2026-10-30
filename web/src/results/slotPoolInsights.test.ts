import { afterEach, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { noSaturation, summary } from "../test/fixtures";
import { formatHeadroom, formatSaturation } from "./saturation";

afterEach(() => setLanguage("en"));

const label = { code: "RESULT_SLOT_POOL", message: "connection pool order-service#2 → pgbouncer",
  args: { from: "order-service#2", to: "pgbouncer" } };

it.each([
  ["en", "connection pool order-service#2 → pgbouncer"],
  ["ru", "пул соединений order-service#2 → pgbouncer"],
] as const)("names a connection pool in first saturation and paths in %s", (language, expected) => {
  setLanguage(language);
  const text = formatSaturation({ ...noSaturation, withoutSaturation: 0,
    firstNodes: [{ node: "to-pgbouncer#2", slotPool: "pool", label,
      replicationCount: 1, medianStartMs: 50, minStartMs: 50, maxStartMs: 50 }],
    replications: [{ replication: 0, degradationPath: [{ node: "to-pgbouncer#2", slotPool: "pool", label, startMs: 50 }] }],
  }, 1);
  expect(text.firstNodes[0]).toContain(expected);
  expect(text.degradationPaths[0]).toContain(expected);
});

it("formats core headroom even when a different browser-side maximum could be inferred", () => {
  const aggregate = summary.variants[0].points[0].aggregate;
  const text = formatHeadroom(aggregate, { utilization: { node: "to-pgbouncer#2", slotPool: "pool", value: 0.91, label },
    meanQueueLength: null });
  expect(text).toContain("91% at connection pool order-service#2 → pgbouncer");
  expect(text).not.toContain("50%");
});
