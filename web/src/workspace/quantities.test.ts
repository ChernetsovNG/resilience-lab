import { describe, expect, it } from "vitest";
import { unitsOf } from "../test/fixtures";
import { canonicalOf } from "./quantities";

const { DURATION: duration, RATE: rate, PROBABILITY: probability } = unitsOf;

describe("canonicalOf", () => {
  it("scales the listed units to canonical values like the core parser", () => {
    expect(canonicalOf("250ms", duration)).toBe(250);
    expect(canonicalOf("1.5min", duration)).toBe(90000);
    expect(canonicalOf("120/s", rate)).toBe(0.12);
    expect(canonicalOf("0.5%", probability)).toBe(0.005);
  });

  it("rejects missing, foreign and malformed units", () => {
    for (const text of ["250", "250 ms", "-1ms", "1h", "1e999ms", "1.ms"]) {
      expect(canonicalOf(text, duration)).toBeNull();
    }
    expect(canonicalOf("120/s", duration)).toBeNull();
    expect(canonicalOf("5ms", probability)).toBeNull();
  });
});
