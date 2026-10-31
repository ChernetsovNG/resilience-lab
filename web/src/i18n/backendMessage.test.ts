import { afterEach, describe, expect, it } from "vitest";
import { messages } from "./index";
import { backendMessage } from "./backendMessage";

const catalog = messages as Record<string, string>;
const additions = {
  "messages.TEST_MESSAGE": "Value {count} for '{name}'",
  "messages.TEST_MESSAGE.limit": "Limit {count} for '{name}'",
  "messages.TEST_FIXED": "Request failed",
  "messages.TEST_UNIT": "Value {value} {unit}",
  "messages.unit.testUnit": "translated unit",
};

afterEach(() => {
  for (const key of Object.keys(additions)) delete catalog[key];
});

describe("backend messages", () => {
  it("translates an execution cause and preserves its task context", () => {
    expect(backendMessage({ code: "EXECUTION_REAL_TIME_LIMIT", message: "legacy", args: {
      seconds: 1, variant: "baseline", point: "p0", replication: 2,
    } })).toBe("Variant 'baseline', point 'p0', replication 2: Replication exceeded its real-time cap before full drain (limit: 1 s)");
  });

  it("keeps the replica number when translating a parameter diagnostic", () => {
    expect(backendMessage({ code: "PARAM_RANGE", message: "legacy", args: {
      reason: "minimum", parameter: "handlers", minimum: 1, service: "worker", replica: 2,
    } })).toBe("Replica worker#2: Parameter 'handlers' is out of range: >= 1");
  });

  it("formats raw numbers with the shared formatter and keeps user strings intact", () => {
    Object.assign(catalog, additions);
    expect(backendMessage({ code: "TEST_MESSAGE", message: "legacy", args: { count: 1234.5, name: "$& {count}" } }))
      .toBe("Value 1,234.5 for '$& {count}'");
  });

  it("translates known unit tokens while preserving other scalar strings", () => {
    Object.assign(catalog, additions);
    expect(backendMessage({ code: "TEST_UNIT", message: "legacy", args: { value: 80, unit: "testUnit" } }))
      .toBe("Value 80 translated unit");
    expect(backendMessage({ code: "TEST_UNIT", message: "legacy", args: { value: 80, unit: "custom" } }))
      .toBe("Value 80 custom");
  });

  it("uses a structured reason without changing the stable code", () => {
    Object.assign(catalog, additions);
    expect(backendMessage({ code: "TEST_MESSAGE", message: "legacy", args: { reason: "limit", count: 0, name: "service" } }))
      .toBe("Limit 0 for 'service'");
  });

  it("preserves grid point context with a localized suffix", () => {
    Object.assign(catalog, additions);
    expect(backendMessage({ code: "TEST_MESSAGE", message: "legacy", args: { count: 5, name: "service", points: "p1, p2" } }))
      .toBe("Value 5 for 'service' (points: p1, p2)");
  });

  const fallbackCases: { code: string | null; args: Record<string, string | number> | null }[] = [
    { code: "UNKNOWN", args: {} },
    { code: "TEST_MESSAGE", args: { count: 2 } },
    { code: "TEST_MESSAGE", args: null },
    { code: "TEST_MESSAGE", args: { reason: "unknown", count: 2, name: "service" } },
    { code: "TEST_MESSAGE", args: { count: Number.NaN, name: "service" } },
    { code: null, args: {} },
  ];
  it.each(fallbackCases)("retains the server text for an unknown code or incomplete arguments: %j", value => {
    Object.assign(catalog, additions);
    expect(backendMessage({ ...value, message: "Original server text" })).toBe("Original server text");
  });

  it("formats amplification beyond the browser safe integer range without changing its digits", () => {
    expect(backendMessage({ code: "LINT_RETRY_AMPLIFICATION", message: "legacy", args: {
      amplification: "4611686014132420609", threshold: 10,
    } })).toContain("up to 4,611,686,014,132,420,609 attempts per request");
  });

  it("keeps very large amplification localized without overflowing to Infinity", () => {
    const text = backendMessage({ code: "LINT_RETRY_AMPLIFICATION", message: "legacy", args: {
      amplification: "1" + "0".repeat(314), threshold: 10,
    } });
    expect(text).toMatch(/^Nested retries allow up to 100,000,000,/);
    expect(text).toContain(",000 attempts per request, above the warning threshold of 10");
    expect(text.split(" attempts ")[0].replace(/[^0-9]/g, "")).toBe("1" + "0".repeat(314));
  });

  it("keeps resume recovery guidance around translated failures", () => {
    Object.assign(catalog, additions);
    expect(backendMessage({ code: "TEST_FIXED", message: "legacy", args: {}, requiresNewRun: true }))
      .toBe("Request failed Start a new run with Run.");
  });

  it("translates messages with no parameters and accepts older responses", () => {
    Object.assign(catalog, additions);
    expect(backendMessage({ code: "TEST_FIXED", message: "legacy", args: {} })).toBe("Request failed");
    expect(backendMessage({ code: "TEST_FIXED", message: "legacy" })).toBe("legacy");
    expect(backendMessage({ code: "TEST_FIXED", message: "legacy", args: null })).toBe("legacy");
  });
});
