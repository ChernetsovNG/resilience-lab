import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { comparisonConclusion } from "./findings";
import { summary } from "../test/fixtures";

const measured = (mean: number, stdDev: number) => ({ mean, stdDev, count: 10, min: mean, max: mean });
afterEach(() => setLanguage("en"));

describe("comparisonConclusion wording", () => {
  it.each([
    { language: "en", criterion: "successRate", mean: 0.769, expected: "Success rate: 76.9%." },
    { language: "ru", criterion: "successRate", mean: 0.769, expected: "Доля успешных запросов: 76,9\u00a0%." },
    { language: "en", criterion: "p99LatencyMs", mean: 5031.25, expected: "p99: 5.03 s." },
    { language: "ru", criterion: "p99LatencyMs", mean: 5031.25, expected: "p99: 5,03 с." },
  ] as const)("states only the single variant's $criterion in $language", ({ language, criterion, mean, expected }) => {
    setLanguage(language);
    expect(comparisonConclusion([{ label: "X", metric: measured(mean, 0) }], criterion, 95)).toBe(expected);
  });

  it.each([
    { language: "en", criterion: "successRate", means: [0.85, 0.84, 0.83], spread: 0.05,
      expected: "No clear best success rate — the difference is within the spread (highest observed: “X”, 85%)." },
    { language: "ru", criterion: "successRate", means: [0.85, 0.84, 0.83], spread: 0.05,
      expected: "Явного лучшего по доле успешных нет — разница в пределах разброса (наибольшая наблюдаемая: «X», 85\u00a0%)." },
    { language: "en", criterion: "p99LatencyMs", means: [5031.25, 5100, 5200], spread: 500,
      expected: "No clear best p99 — the difference is within the spread (lowest observed: “X”, 5.03 s)." },
    { language: "ru", criterion: "p99LatencyMs", means: [5031.25, 5100, 5200], spread: 500,
      expected: "Явного лучшего по p99 нет — разница в пределах разброса (наименьший наблюдаемый: «X», 5,03 с)." },
  ] as const)("leads with no clear best $criterion when every interval overlaps in $language", ({ language, criterion, means, spread, expected }) => {
    setLanguage(language);
    const observations = means.map((mean, index) => ({ label: ["X", "Y", "Z"][index], metric: measured(mean, spread) }));
    expect(comparisonConclusion(observations, criterion, 95)).toBe(expected);
  });

  it.each([
    { language: "en", expected: "Best observed success rate: “X” (85%); difference within the spread: “Y”; intervals do not overlap with “Z”." },
    { language: "ru", expected: "Лучшая наблюдаемая доля успешных запросов: «X» (85\u00a0%); разница в пределах разброса: «Y»; интервалы не перекрываются: «Z»." },
  ] as const)("preserves mixed overlap and separation in $language", ({ language, expected }) => {
    setLanguage(language);
    expect(comparisonConclusion([
      { label: "X", metric: measured(0.85, 0.05) },
      { label: "Y", metric: measured(0.84, 0.05) },
      { label: "Z", metric: measured(0.3, 0.01) },
    ], "successRate", 95)).toBe(expected);
  });

  it.each([
    { language: "en", expected: "Best observed success rate: “X” (85%); interval comparison unavailable: “Y”." },
    { language: "ru", expected: "Лучшая наблюдаемая доля успешных запросов: «X» (85\u00a0%); сравнение интервалов недоступно: «Y»." },
  ] as const)("does not treat a second variant without data as a single variant or overlapping intervals in $language", ({ language, expected }) => {
    setLanguage(language);
    expect(comparisonConclusion([
      { label: "X", metric: measured(0.85, 0.05) }, { label: "Y", metric: null },
    ], "successRate", 95)).toBe(expected);
  });
});

describe("comparison costs", () => {
  it.each([
    { language: "en", expected: "fallback responses for 12.9% of original requests" },
    { language: "ru", expected: "заглушка у 12,9\u00a0% исходных запросов" },
  ] as const)("shows fallback cost even without a clear winner in $language", ({ language, expected }) => {
    setLanguage(language);
    const aggregate = structuredClone(summary.variants[0].points[0].aggregate);
    aggregate.entries.total.degradedRate = measured(0.129, 0);
    const conclusion = comparisonConclusion([
      { label: "Deferred", metric: measured(1, 0.01), aggregate },
      { label: "Real response", metric: measured(0.999, 0.01) },
    ], "successRate", 95);
    expect(conclusion).toContain(language === "en" ? "No clear best" : "Явного лучшего");
    expect(conclusion).toContain(expected);
  });

  it("keeps each tied leader's own cost and omits zero costs", () => {
    const aggregate = structuredClone(summary.variants[0].points[0].aggregate);
    aggregate.entries.total.degradedRate = measured(0.129, 0);
    const conclusion = comparisonConclusion([
      { label: "Fallback", metric: measured(1, 0), aggregate },
      { label: "Real response", metric: measured(1, 0) },
      { label: "Other", metric: measured(0.5, 0) },
    ], "successRate", 95);
    expect(conclusion).toContain("in “Fallback”: fallback responses for 12.9% of original requests");
    expect(conclusion).not.toContain("in “Real response”:");
    expect(conclusion).not.toContain("rejected 0%");
  });

  it("reports retry-budget denials as attempts across replications, never as a request percentage", () => {
    const aggregate = structuredClone(summary.variants[0].points[0].aggregate);
    const connection = { pooledLatency: null, timeoutRate: null, meanInFlight: null, slotPoolSummaries: {}, totals: {
      sentAttempts: 100, retries: 10, succeeded: 80, failed: 20, timeouts: 20, orphaned: 0,
      inFlightIntegralMs: 0, orphanedIntegralMs: 0, backoffIntegralMs: 0, measurementMs: 1000,
      slotPools: {}, failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 12, fallbacks: 0,
    } };
    aggregate.connections = { first: connection, second: { ...connection, totals: { ...connection.totals, retriesDenied: 3 } } };
    const conclusion = comparisonConclusion([{ label: "Budget", metric: measured(1, 0), aggregate }], "successRate", 95);
    expect(conclusion).toContain("retry budget denied 15 attempts across replications");
    expect(conclusion).not.toContain("15%");
    aggregate.groups = [{ id: "calls", kind: "CONNECTION", instances: [{ id: "first", replica: 1 }, { id: "second", replica: 2 }] }];
    aggregate.connections.first.totals.retriesDenied = 2;
    aggregate.connections.second.totals.retriesDenied = 3;
    aggregate.connections.calls = { ...connection, totals: { ...connection.totals, retriesDenied: 5 } };
    expect(comparisonConclusion([{ label: "Budget", metric: measured(1, 0), aggregate }], "successRate", 95))
      .toContain("retry budget denied 5 attempts across replications");
  });
});
