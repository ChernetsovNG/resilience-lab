import { describe, expect, it } from "vitest";
import { noSaturation } from "../test/fixtures";
import { formatSaturation } from "./saturation";

describe("formatSaturation", () => {
  it("formats the recorded first node, onset statistics and degradation paths in ms", () => {
    const text = formatSaturation({
      ...noSaturation,
      withoutSaturation: 0,
      firstNodes: [{ node: "dependency", replicationCount: 2, medianStartMs: 225, minStartMs: 210, maxStartMs: 240 }],
      replications: [
        { replication: 0, degradationPath: [{ node: "dependency", startMs: 210 }, { node: "middle", startMs: 260 }] },
        { replication: 1, degradationPath: [{ node: "dependency", startMs: 240 }, { node: "gateway", startMs: 300 }] },
      ],
    }, 2);
    expect(text.firstNodes).toEqual([
      "dependency first in 2 of 2 replications; median start 225.0 ms, range 210.0–240.0 ms.",
    ]);
    expect(text.degradationPaths).toEqual([
      "Replication 0: dependency at 210.0 ms → middle at 260.0 ms",
      "Replication 1: dependency at 240.0 ms → gateway at 300.0 ms",
    ]);
  });

  it("preserves different first nodes and ties in the order supplied by the core", () => {
    const text = formatSaturation({
      ...noSaturation,
      withoutSaturation: 0,
      firstNodes: [
        { node: "middle", replicationCount: 1, medianStartMs: 70, minStartMs: 70, maxStartMs: 70 },
        { node: "dependency", replicationCount: 1, medianStartMs: 80, minStartMs: 80, maxStartMs: 80 },
      ],
      replications: [
        { replication: 0, degradationPath: [{ node: "middle", startMs: 70 }] },
        { replication: 1, degradationPath: [{ node: "dependency", startMs: 80 }] },
      ],
    }, 2);
    expect(text.firstNodes).toEqual([
      "middle first in 1 of 2 replications; median start 70.0 ms, range 70.0–70.0 ms.",
      "dependency first in 1 of 2 replications; median start 80.0 ms, range 80.0–80.0 ms.",
    ]);
  });

  it("reports replications without saturation separately without diluting onset statistics", () => {
    const text = formatSaturation({
      ...noSaturation,
      withoutSaturation: 1,
      firstNodes: [{ node: "dependency", replicationCount: 1, medianStartMs: 80, minStartMs: 80, maxStartMs: 80 }],
      replications: [
        { replication: 0, degradationPath: [{ node: "dependency", startMs: 80 }] },
        { replication: 1, degradationPath: [] },
      ],
    }, 2);
    expect(text.firstNodes[0]).toBe("dependency first in 1 of 2 replications; median start 80.0 ms, range 80.0–80.0 ms.");
    expect(text.withoutSaturation).toBe("1 of 2 replications without saturation.");
    expect(text.degradationPaths[1]).toBe("Replication 1: no saturation.");
  });

  it("explicitly states when no replication saturated", () => {
    const text = formatSaturation(noSaturation, 2);
    expect(text.firstNodes).toEqual(["No saturation."]);
    expect(text.withoutSaturation).toBe("2 of 2 replications without saturation.");
    expect(text.degradationPaths).toEqual(["Replication 0: no saturation.", "Replication 1: no saturation."]);
  });

  it("includes additional rule parameters from the API without rounding or a field allowlist", () => {
    const saturation = { ...noSaturation, rule: { ...noSaturation.rule, futureDurationMs: 125, futureThreshold: 0.12345 } };
    const original = structuredClone(saturation);
    const text = formatSaturation(saturation, 2);
    expect(text.rule).toContain("futureDurationMs = 125");
    expect(text.rule).toContain("futureThreshold = 0.12345");
    expect(saturation).toEqual(original);
  });
});
