import { afterEach, expect, it } from "vitest";
import type { Catalog } from "../api/apiTypes";
import { setLanguage } from "../i18n";
import rawCatalog from "../test/catalog.json";
import { unitsOf } from "../test/fixtures";
import { formatParameterValue } from "./parameterValues";
import { parseParam } from "./paramParsing";

const duration = (rawCatalog as Catalog).types.find(type => type.id === "call")!.params.find(param => param.name === "timeout")!;
afterEach(() => setLanguage("en"));

it.each([
  ["en", "150ms", "150 ms"], ["ru", "150ms", "150 мс"],
  ["en", "1500ms", "1,500 ms"], ["ru", "1.25s", "1,25 с"],
  ["en", "2min", "2 min"], ["ru", "2min", "2 мин"],
  ["en", "0.00001s", "0.00001 s"],
] as const)("localizes %s duration %s while preserving the chosen unit and precision", (locale, value, expected) => {
  setLanguage(locale);
  expect(formatParameterValue(value, duration)).toBe(expected);
  expect(formatParameterValue(value)).toBe(expected);
});

it("does not reinterpret arbitrary text or another quantity dimension as a duration", () => {
  expect(formatParameterValue("10s2s", duration)).toBe("10s2s");
  expect(formatParameterValue("150ms", { ...duration, kind: "STRING", dimension: null, units: [] })).toBe("150ms");
  expect(formatParameterValue("100/s", { ...duration, dimension: "RATE", units: unitsOf.RATE })).toBe("100/s");
});

it.each([
  ["DURATION", "250ms"], ["RATE", "100/s"], ["PROBABILITY", "10%"],
] as const)("gives a valid %s example for malformed quantity input", (dimension, example) => {
  const parsed = parseParam({ ...duration, dimension, units: unitsOf[dimension] }, "10s2s");
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.message).toContain(example);
});


it.each([
  ["en", "Attempt timeout, Circuit breaker open, unknownFailure"],
  ["ru", "Таймаут попытки, Предохранитель вызовов разомкнут, unknownFailure"],
] as const)("localizes known array choices in %s while preserving unsupported literals", (locale, expected) => {
  setLanguage(locale);
  const descriptor = (rawCatalog as Catalog).types.find(type => type.id === "call")!.params.find(param => param.name === "fallback")!
    .fields.find(param => param.name === "on")!;
  expect(formatParameterValue(["timeout", "circuitOpen", "unknownFailure"], descriptor)).toBe(expected);
  expect(formatParameterValue("unknownFailure", descriptor)).toBe("unknownFailure");
  expect(formatParameterValue("circuitOpen", descriptor)).toBe(expected.split(", ")[1]);
});
