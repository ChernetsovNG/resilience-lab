import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "./index";
import { formatDuration, formatInterval, formatNumber, formatPercent, formatRate, formatSize } from "./format";

afterEach(() => {
  vi.restoreAllMocks();
  i18n.setLanguage("en");
  localStorage.clear();
});

describe("language preference", () => {
  it.each([
    [["ru-RU", "en-US"], null, "ru"],
    [["RU", "en"], null, "ru"],
    [["de-DE", "ru-BY", "en-US"], null, "ru"],
    [["en-GB", "ru-RU"], null, "en"],
    [["de-DE"], null, "en"],
    [[], null, "en"],
    [["ru-RU"], "en", "en"],
    [["en-US"], "ru", "ru"],
    [["ru-RU"], "invalid", "ru"],
  ])("selects from %j with saved %s", (languages, saved, expected) => {
    expect(i18n.chooseLanguage(languages as string[], saved as string | null)).toBe(expected);
  });

  it("changes messages, formatting, html language and the persisted preference together", () => {
    i18n.setLanguage("ru");
    expect(i18n.language).toBe("ru");
    expect(i18n.t("app.topBar.save")).toBe("Сохранить");
    expect(document.documentElement.lang).toBe("ru");
    expect(localStorage.getItem("resilience-lab.language")).toBe("ru");
    expect(formatNumber(1200.25)).toBe("1\u00a0200,25");
    expect(formatPercent(0.657)).toBe("65,7\u00a0%");
    expect(formatPercent(-0.1)).toBe("-10\u00a0%");
    expect(formatPercent(1.2)).toBe("120\u00a0%");
    expect(formatDuration(80)).toBe("80 мс");
    expect(formatDuration(1.23456, "s")).toBe("1,235 с");
    expect(formatRate(1200)).toBe("1\u00a0200 RPS");
    expect(formatSize(819200)).toBe("800 КиБ");
    expect(formatSize(1048576)).toBe("1 МиБ");
    expect(formatInterval(-0.1, 1.2, formatPercent)).toContain("-10\u00a0%–120\u00a0%");
    i18n.setLanguage("en");
    expect(i18n.t("app.topBar.save")).toBe("Save");
    expect(formatNumber(1200.25)).toBe("1,200.25");
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps switching usable when saving the preference is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    expect(() => i18n.setLanguage("ru")).not.toThrow();
    expect(i18n.t("app.topBar.save")).toBe("Сохранить");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("initializes from saved choice before browser languages", async () => {
    localStorage.setItem("resilience-lab.language", "en");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["ru-RU"]);
    vi.resetModules();
    const fresh = await import("./index");
    expect(fresh.language).toBe("en");
    localStorage.clear();
    vi.resetModules();
    const russian = await import("./index");
    expect(russian.language).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("initializes from browser languages when reading storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["ru-RU"]);
    vi.resetModules();
    const fresh = await import("./index");
    expect(fresh.language).toBe("ru");
  });
});
