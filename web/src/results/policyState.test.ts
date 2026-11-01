import { expect, it } from "vitest";
import { policyWindowState } from "./policyState";

it("normalizes repeated circuit breaker openings by actual window duration and caller copies", () => {
  expect(policyWindowState({ durationMs: 100, circuitOpenMs: 120 }, 3).circuitOpenShare).toBe(0.4);
  expect(policyWindowState({ durationMs: 25, circuitOpenMs: 10 }).circuitOpenShare).toBe(0.4);
  expect(policyWindowState({ durationMs: 100, circuitOpenMs: 0 }, 3).circuitOpenShare).toBe(0);
});

it("preserves window exclusion and readiness integrals, with missing values distinct from zero", () => {
  expect(policyWindowState({ durationMs: 100, ejectedMs: 80, notReadyMs: 20 })).toEqual({
    circuitOpenShare: null, ejectedShare: 0.8, notReadyShare: 0.2,
  });
  expect(policyWindowState({ durationMs: 0, circuitOpenMs: 10, ejectedMs: 5 })).toEqual({
    circuitOpenShare: null, ejectedShare: null, notReadyShare: null,
  });
  expect(policyWindowState({ durationMs: 100, circuitOpenMs: 100 }, 0).circuitOpenShare).toBeNull();
});
