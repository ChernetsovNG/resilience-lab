import { describe, expect, it } from "vitest";
import type { OutputCalculation } from "../api/apiTypes";
import fixture from "./series/fixtures/catalog-outputs.json";
import { calculateOutput } from "./outputs";

describe("catalog output interpreter contract", () => {
  for (const golden of fixture as { calculation: OutputCalculation; cases: { context: unknown; expected?: number | null }[] }[]) {
    it(`${golden.calculation.kind} ${golden.calculation.field}`, () => {
      for (const sample of golden.cases) {
        expect(calculateOutput(golden.calculation, sample.context)).toBe(sample.expected ?? null);
      }
    });
  }
});
