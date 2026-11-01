import { afterEach, describe, expect, it, vi } from "vitest";
import { messages, setLanguage, t } from "./index";
import { catalogText, localizeCatalog } from "./catalog";
import catalogSnapshot from "../test/catalog.json" with { type: "json" };
import type { Catalog } from "../api/apiTypes";

const catalog = catalogSnapshot as Catalog;

function englishCatalog() {
  const expected = structuredClone(catalog);
  const classes = expected.types.find(type => type.id === "client")!.params.find(param => param.name === "classes")!;
  classes.title = "Request types";
  classes.description = "Load profiles by request type; use either one profile or request types. Variants replace the entire list; grids are not supported.";
  classes.fields.find(field => field.name === "id")!.title = "Request type ID";
  classes.fields.find(field => field.name === "load")!.description = "Average arrival rate for this request type over time, including warm-up; it changes linearly between points.";
  return expected;
}

describe("messages", () => {
  afterEach(() => { vi.unstubAllEnvs(); setLanguage("en"); localStorage.clear(); });

  it("uses API values or keys as safe production fallbacks", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("MODE", "production");
    expect(t("app.job.status.PAUSED")).toBe("PAUSED");
    expect(t("results.jobStatus.PAUSED")).toBe("PAUSED");
    expect(t("missing.message")).toBe("missing.message");
    expect(t("common.interval", { level: "95%", low: "0" })).toBe("common.interval");
  });

  it("substitutes named parameters independently of their order", () => {
    expect(t("common.interval", { high: "8", level: "99%", low: "-2" })).toBe("99% CI -2–8");
    expect(t("common.interval", { high: "$& {low}", level: "90%", low: "-2" })).toBe("90% CI -2–$& {low}");
  });
  it("fails visibly on unknown keys and missing parameters", () => {
    expect(() => t("missing.message")).toThrow("missing.message");
    expect(() => t("common.interval", { level: "95%", low: "0" })).toThrow("high");
  });
  it.each(["test", "development"])("keeps %s mode strict", (mode) => {
    vi.stubEnv("DEV", mode === "development");
    vi.stubEnv("MODE", mode);
    expect(() => t("app.job.status.PAUSED")).toThrow("PAUSED");
    expect(() => t("common.interval", { level: "95%", low: "0" })).toThrow("high");
  });
  it("uses stable type and nested parameter identifiers before API text", () => {
    const additions = {
      "catalog.types.service.title": "Translated service",
      "catalog.types.service.params.processing.mean.title": "Translated mean",
      "catalog.types.service.assumptions.0": "Translated assumption",
    };
    const catalogMessages = messages as Record<string, string>;
    const previous = Object.fromEntries(Object.keys(additions).map(key => [key, catalogMessages[key]]));
    Object.assign(catalogMessages, additions);
    try {
      const localized = localizeCatalog(catalog);
      expect(localized.types[1].title).toBe("Translated service");
      expect(localized.types[1].params[2].fields[1].title).toBe("Translated mean");
      expect(localized.types[1].assumptions[0]).toBe("Translated assumption");
      expect(catalog.types[1].title).toBe("Service");
      expect(localized.types[1].params[2].fields[1].name).toBe("mean");
    } finally {
      Object.assign(catalogMessages, previous);
    }
  });
  it("falls back to API text and preserves the original catalog", () => {
    expect(catalogText("catalog.types.future.title", "Future type")).toBe("Future type");
    const localized = localizeCatalog(catalog);
    expect(localized).toEqual(englishCatalog());
    expect(localized).not.toBe(catalog);
    expect(localized.types[1].params[2].fields[1].title).toBe("Mean");
  });
  it("localizes API prose without changing identifiers, values or the source response", () => {
    const source = structuredClone(catalog);
    setLanguage("ru");
    const localized = localizeCatalog(catalog);
    expect(localized.types[1].title).toBe("Сервис");
    expect(localized.types[1].params[0].title).toBe("Обработчики");
    expect(localized.types[1].params[2].fields[1].name).toBe("mean");
    expect(localized.types[1].params[1].default).toBe(0);
    expect(catalog).toEqual(source);
    setLanguage("en");
    expect(localizeCatalog(catalog)).toEqual(englishCatalog());
  });
});
