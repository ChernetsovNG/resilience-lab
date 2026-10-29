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
      "dependency first in 2 of 2 replications; median start 225 ms, range 210–240 ms.",
    ]);
    expect(text.degradationPaths).toEqual([
      "Replication 0: dependency at 210 ms → middle at 260 ms",
      "Replication 1: dependency at 240 ms → gateway at 300 ms",
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
      "middle first in 1 of 2 replications; median start 70 ms, range 70–70 ms.",
      "dependency first in 1 of 2 replications; median start 80 ms, range 80–80 ms.",
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
    expect(text.firstNodes[0]).toBe("dependency first in 1 of 2 replications; median start 80 ms, range 80–80 ms.");
    expect(text.withoutSaturation).toBe("1 of 2 replications without saturation.");
    expect(text.degradationPaths[1]).toBe("Replication 1: no saturation.");
  });

  it("explicitly states when no replication saturated", () => {
    const text = formatSaturation(noSaturation, 2);
    expect(text.firstNodes).toEqual(["No saturation."]);
    expect(text.withoutSaturation).toBe("2 of 2 replications without saturation.");
    expect(text.degradationPaths).toEqual(["Replication 0: no saturation.", "Replication 1: no saturation."]);
  });

  it.each([
    [100, 0.95, 0.5, 0, "95%", "0.5", "100 ms", "0"],
    [275, 0.82, 1.75, 3, "82%", "1.75", "275 ms", "3"],
  ])("explains all recorded rule thresholds (%s ms, %s, %s, %s)",
    (minimumDurationMs, handlerUtilizationThreshold, meanQueueLengthThreshold, queueRejectionsThreshold, utilization, queue, duration, rejections) => {
      const saturation = { ...noSaturation, rule: { minimumDurationMs: Number(minimumDurationMs),
        handlerUtilizationThreshold: Number(handlerUtilizationThreshold), meanQueueLengthThreshold: Number(meanQueueLengthThreshold),
        queueRejectionsThreshold: Number(queueRejectionsThreshold) } };
      const text = formatSaturation(saturation, 2);
      expect(text.rule).toBe(`A service counts as saturated when handler utilization stays at or above ${utilization} and the mean queue stays above ${queue} for at least ${duration}. It also counts as saturated when each consecutive window has more than ${rejections} queue rejections and the window starts span at least ${duration}.`);
      expect(text.rule).not.toMatch(/minimumDurationMs|handlerUtilizationThreshold|meanQueueLengthThreshold|queueRejectionsThreshold/);
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
