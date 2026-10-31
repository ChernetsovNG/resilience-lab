import { afterEach, expect, it } from "vitest";
import { backendMessage } from "./backendMessage";
import { setLanguage } from "./index";

afterEach(() => { setLanguage("en"); localStorage.clear(); });

it("translates backend units and grid context while keeping the parameter and point identifiers", () => {
  setLanguage("ru");
  expect(backendMessage({ code: "PARAM_RANGE", message: "legacy", args: {
    reason: "minimumUnit", parameter: "processing.mean", minimum: 80, unit: "ms", points: "p0, p1",
  } })).toBe("Значение параметра «processing.mean» должно быть не меньше 80 мс (точки: p0, p1)");
});

it("formats a Russian amplification message without losing digits beyond safe integers", () => {
  setLanguage("ru");
  expect(backendMessage({ code: "LINT_RETRY_AMPLIFICATION", message: "legacy", args: {
    amplification: "4611686014132420609", threshold: 10,
  } })).toContain("до 4\u00a0611\u00a0686\u00a0014\u00a0132\u00a0420\u00a0609 попыток на запрос");
});
