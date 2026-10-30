import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const load = async () => { vi.resetModules(); return import("./confidenceLevel"); };

it.each([null, "invalid", "0", "100", "NaN"])("defaults to 95%% for an absent or invalid preference (%s)", async saved => {
  if (saved !== null) localStorage.setItem("resilience-lab.confidenceLevel", saved);
  expect((await load()).currentConfidenceLevel()).toBe(95);
});

it.each([80, 90, 95, 99] as const)("restores the selected %s%% level after loading again", async level => {
  const store = await load();
  store.setConfidenceLevel(level);
  expect(localStorage.getItem("resilience-lab.confidenceLevel")).toBe(String(level));
  expect((await load()).currentConfidenceLevel()).toBe(level);
});

it("keeps the in-session selection usable when browser storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
  const store = await load();
  expect(store.currentConfidenceLevel()).toBe(95);
  expect(() => store.setConfidenceLevel(99)).not.toThrow();
  expect(store.currentConfidenceLevel()).toBe(99);
});
