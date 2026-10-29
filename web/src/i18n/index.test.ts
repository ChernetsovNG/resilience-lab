import { describe, expect, it } from "vitest";
import { messages, t } from "./index";
import { catalogText, localizeCatalog } from "./catalog";
import { catalog } from "../test/fixtures";

describe("messages", () => {
  it("substitutes named parameters independently of their order", () => {
    expect(t("common.interval", { high: "8", low: "-2" })).toBe("95% CI -2–8");
    expect(t("common.interval", { high: "$& {low}", low: "-2" })).toBe("95% CI -2–$& {low}");
  });
  it("fails visibly on unknown keys and missing parameters", () => {
    expect(() => t("missing.message")).toThrow("missing.message");
    expect(() => t("common.interval", { low: "0" })).toThrow("high");
  });
  it("uses stable type and nested parameter identifiers before API text", () => {
    const additions = {
      "catalog.types.service.title": "Translated service",
      "catalog.types.service.params.processing.mean.title": "Translated mean",
      "catalog.types.service.assumptions.0": "Translated assumption",
    };
    const catalogMessages = messages as Record<string, string>;
    Object.assign(catalogMessages, additions);
    try {
      const localized = localizeCatalog(catalog);
      expect(localized.types[1].title).toBe("Translated service");
      expect(localized.types[1].params[2].fields[1].title).toBe("Translated mean");
      expect(localized.types[1].assumptions[0]).toBe("Translated assumption");
      expect(catalog.types[1].title).toBe("Service");
      expect(localized.types[1].params[2].fields[1].name).toBe("mean");
    } finally {
      for (const key of Object.keys(additions)) delete catalogMessages[key];
    }
  });
  it("falls back to API text and preserves the original catalog", () => {
    expect(catalogText("catalog.types.service.title", "Service")).toBe("Service");
    const localized = localizeCatalog(catalog);
    expect(localized).toEqual(catalog);
    expect(localized).not.toBe(catalog);
    expect(localized.types[1].params[2].fields[1].title).toBe("Mean");
  });
});
