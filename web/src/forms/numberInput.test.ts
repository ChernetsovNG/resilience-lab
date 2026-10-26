import { describe, expect, it } from "vitest";
import { parseFiniteNumber } from "./numberInput";

describe("parseFiniteNumber", () => {
  it.each(["", "   ", "abc", "NaN", "Infinity", "-Infinity"])(
    "rejects non-finite input %j",
    (raw) => {
      expect(parseFiniteNumber(raw)).toBeNull();
    },
  );

  it.each([
    ["-12.5", -12.5],
    ["0", 0],
    ["0.25", 0.25],
    ["42", 42],
  ])("parses finite input %j", (raw, expected) => {
    expect(parseFiniteNumber(raw)).toBe(expected);
  });
});
