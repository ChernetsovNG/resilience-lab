import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { slotPoolResource, noSaturation } from "../test/fixtures";
import { formatSaturation } from "./saturation";

afterEach(() => setLanguage("en"));

describe("readable saturation evidence", () => {
  const saturatedAt = (startMs: number) => ({
    ...noSaturation, withoutSaturation: 0,
    firstNodes: [{ node: "payment", ...slotPoolResource("payment"), replicationCount: 2,
      medianStartMs: startMs, minStartMs: startMs, maxStartMs: startMs }],
  });
  const fault = { label: "psp · slowdown 8× · 20–40 s", fromMs: 20000, toMs: 40000 };

  it.each([20000, 21600, 39999])("names a fault overlapping the recorded onset (%s)", onset => {
    expect(formatSaturation(saturatedAt(onset), 2, [fault]).causes).toEqual([
      "The median saturation onset is during fault psp · slowdown 8× · 20–40 s.",
    ]);
  });
  it.each([19999, 40000, 80000])("does not associate an onset outside the fault (%s)", onset => {
    expect(formatSaturation(saturatedAt(onset), 2, [fault]).causes).toEqual([]);
  });
  it("names a just-ended fault only within the next recorded window", () => {
    expect(formatSaturation(saturatedAt(40300), 2, [fault], 600).causes).toEqual([
      "The median saturation onset is just after fault psp · slowdown 8× · 20–40 s (within one series window).",
    ]);
    expect(formatSaturation(saturatedAt(40600), 2, [fault], 600).causes).toEqual([]);
    expect(formatSaturation(noSaturation, 2, [fault], 600).causes).toEqual([]);
    expect(formatSaturation(saturatedAt(21600), 2, [{ ...fault, fromMs: null }]).causes).toEqual([]);
  });
  it.each([
    { label: slotPoolResource("service-1").label, expected: "обработчики service-1" },
    { label: { code: "RESULT_SLOT_POOL", message: "connection pool service-1 → database-1",
      args: { from: "service-1", to: "database-1" } }, expected: "пул соединений service-1 → database-1" },
  ])("uses a complete Russian phrase for $expected", ({ label, expected }) => {
    setLanguage("ru");
    const saturation = { ...saturatedAt(21600), firstNodes: [{ ...saturatedAt(21600).firstNodes[0], label }] };
    const text = formatSaturation(saturation, 2);
    expect(text.firstNodes[0]).toContain(`Первое насыщение: ${expected}`);
    expect(text.firstNodes[0]).not.toContain("первым достигает");
    expect(text.firstNodes[0]).toContain("21,6 с");
  });
  it("groups equal resource paths while preserving their onset ranges", () => {
    const saturation = { ...noSaturation, replications: [
      { replication: 0, degradationPath: [{ node: "payment", ...slotPoolResource("payment"), startMs: 21000 }] },
      { replication: 1, degradationPath: [{ node: "payment", ...slotPoolResource("payment"), startMs: 22000 }] },
      { replication: 2, degradationPath: [] }, { replication: 3, degradationPath: [] },
    ] };
    const original = structuredClone(saturation);
    expect(formatSaturation(saturation, 4).degradationPaths).toEqual([
      "handlers payment at 21 s–22 s — 2 of 4 replications",
      "no saturation — 2 of 4 replications",
    ]);
    expect(saturation).toEqual(original);
  });
});

describe("formatSaturation", () => {
  it("formats the recorded first node, onset statistics and degradation paths in ms", () => {
    const text = formatSaturation({
      ...noSaturation,
      withoutSaturation: 0,
      firstNodes: [{ node: "dependency", ...slotPoolResource("dependency"), replicationCount: 2, medianStartMs: 225, minStartMs: 210, maxStartMs: 240 }],
      replications: [
        { replication: 0, degradationPath: [{ node: "dependency", ...slotPoolResource("dependency"), startMs: 210 }, { node: "middle", ...slotPoolResource("middle"), startMs: 260 }] },
        { replication: 1, degradationPath: [{ node: "dependency", ...slotPoolResource("dependency"), startMs: 240 }, { node: "gateway", ...slotPoolResource("gateway"), startMs: 300 }] },
      ],
    }, 2);
    expect(text.firstNodes).toEqual([
      "handlers dependency first in 2 of 2 replications; median start 225 ms, range 210 ms–240 ms.",
    ]);
    expect(text.degradationPaths).toEqual([
      "handlers dependency at 210 ms → handlers middle at 260 ms — 1 of 2 replications",
      "handlers dependency at 240 ms → handlers gateway at 300 ms — 1 of 2 replications",
    ]);
  });

  it("preserves different first nodes and ties in the order supplied by the core", () => {
    const text = formatSaturation({
      ...noSaturation,
      withoutSaturation: 0,
      firstNodes: [
        { node: "middle", ...slotPoolResource("middle"), replicationCount: 1, medianStartMs: 70, minStartMs: 70, maxStartMs: 70 },
        { node: "dependency", ...slotPoolResource("dependency"), replicationCount: 1, medianStartMs: 80, minStartMs: 80, maxStartMs: 80 },
      ],
      replications: [
        { replication: 0, degradationPath: [{ node: "middle", ...slotPoolResource("middle"), startMs: 70 }] },
        { replication: 1, degradationPath: [{ node: "dependency", ...slotPoolResource("dependency"), startMs: 80 }] },
      ],
    }, 2);
    expect(text.firstNodes).toEqual([
      "handlers middle first in 1 of 2 replications; median start 70 ms, range 70 ms–70 ms.",
      "handlers dependency first in 1 of 2 replications; median start 80 ms, range 80 ms–80 ms.",
    ]);
  });

  it("reports replications without saturation separately without diluting onset statistics", () => {
    const text = formatSaturation({
      ...noSaturation,
      withoutSaturation: 1,
      firstNodes: [{ node: "dependency", ...slotPoolResource("dependency"), replicationCount: 1, medianStartMs: 80, minStartMs: 80, maxStartMs: 80 }],
      replications: [
        { replication: 0, degradationPath: [{ node: "dependency", ...slotPoolResource("dependency"), startMs: 80 }] },
        { replication: 1, degradationPath: [] },
      ],
    }, 2);
    expect(text.firstNodes[0]).toBe("handlers dependency first in 1 of 2 replications; median start 80 ms, range 80 ms–80 ms.");
    expect(text.withoutSaturation).toBe("1 of 2 replications without saturation.");
    expect(text.degradationPaths[1]).toBe("no saturation — 1 of 2 replications");
  });

  it("explicitly states when no replication saturated", () => {
    const text = formatSaturation(noSaturation, 2);
    expect(text.firstNodes).toEqual(["No saturation."]);
    expect(text.withoutSaturation).toBe("2 of 2 replications without saturation.");
    expect(text.degradationPaths).toEqual(["no saturation — 2 of 2 replications"]);
  });

  it.each([
    [100, 0.95, 0.5, 0, "95%", "0.5", "100 ms", "0"],
    [275, 0.82, 1.75, 3, "82%", "1.75", "275 ms", "3"],
  ])("explains all recorded rule thresholds (%s ms, %s, %s, %s)",
    (minimumDurationMs, utilizationThreshold, meanQueueLengthThreshold, rejectionsThreshold, utilization, queue, duration, rejections) => {
      const saturation = { ...noSaturation, rule: { minimumDurationMs: Number(minimumDurationMs),
        utilizationThreshold: Number(utilizationThreshold), meanQueueLengthThreshold: Number(meanQueueLengthThreshold),
        rejectionsThreshold: Number(rejectionsThreshold) } };
      const text = formatSaturation(saturation, 2);
      expect(text.rule).toBe(`A slot set counts as saturated when utilization stays at or above ${utilization} and the mean queue stays above ${queue} for at least ${duration}. It also counts as saturated when each consecutive window has more than ${rejections} rejections (queue full or wait limit) and the window starts span at least ${duration}. Slot sets without a waiting queue use only the rejection rule.`);
      expect(text.rule).not.toMatch(/minimumDurationMs|utilizationThreshold|meanQueueLengthThreshold|rejectionsThreshold/);
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
