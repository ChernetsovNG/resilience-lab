import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { comparisonConclusion } from "./findings";

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
      expected: "No clear best success rate — the difference is within the spread (highest observed: X, 85%)." },
    { language: "ru", criterion: "successRate", means: [0.85, 0.84, 0.83], spread: 0.05,
      expected: "Явного лучшего по доле успешных нет — разница в пределах разброса (наибольшая наблюдаемая: X, 85\u00a0%)." },
    { language: "en", criterion: "p99LatencyMs", means: [5031.25, 5100, 5200], spread: 500,
      expected: "No clear best p99 — the difference is within the spread (lowest observed: X, 5.03 s)." },
    { language: "ru", criterion: "p99LatencyMs", means: [5031.25, 5100, 5200], spread: 500,
      expected: "Явного лучшего по p99 нет — разница в пределах разброса (наименьший наблюдаемый: X, 5,03 с)." },
  ] as const)("leads with no clear best $criterion when every interval overlaps in $language", ({ language, criterion, means, spread, expected }) => {
    setLanguage(language);
    const observations = means.map((mean, index) => ({ label: ["X", "Y", "Z"][index], metric: measured(mean, spread) }));
    expect(comparisonConclusion(observations, criterion, 95)).toBe(expected);
  });

  it.each([
    { language: "en", expected: "Best observed success rate: X (85%); difference within the spread: Y; intervals do not overlap with Z." },
    { language: "ru", expected: "Лучшая наблюдаемая доля успешных запросов: X (85\u00a0%); разница в пределах разброса: Y; интервалы не перекрываются с Z." },
  ] as const)("preserves mixed overlap and separation in $language", ({ language, expected }) => {
    setLanguage(language);
    expect(comparisonConclusion([
      { label: "X", metric: measured(0.85, 0.05) },
      { label: "Y", metric: measured(0.84, 0.05) },
      { label: "Z", metric: measured(0.3, 0.01) },
    ], "successRate", 95)).toBe(expected);
  });

  it.each([
    { language: "en", expected: "Best observed success rate: X (85%); interval comparison unavailable: Y." },
    { language: "ru", expected: "Лучшая наблюдаемая доля успешных запросов: X (85\u00a0%); сравнение интервалов недоступно: Y." },
  ] as const)("does not treat a second variant without data as a single variant or overlapping intervals in $language", ({ language, expected }) => {
    setLanguage(language);
    expect(comparisonConclusion([
      { label: "X", metric: measured(0.85, 0.05) }, { label: "Y", metric: null },
    ], "successRate", 95)).toBe(expected);
  });
});
