import { afterEach, expect, it, vi } from "vitest";

const key = "resilience-lab.viewSettings";
const defaults = { gridStep: 20, snapToGrid: true, showGrid: true, textScale: 100 };
const load = async () => { vi.resetModules(); return import("./viewSettings"); };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
});

it.each([null, "invalid", "null", "[]", '{"gridStep":0,"snapToGrid":"false","showGrid":0,"textScale":200}'])("uses the current view defaults for absent or invalid preferences (%s)", async saved => {
    if (saved !== null) localStorage.setItem(key, saved);
    expect((await load()).currentViewSettings()).toEqual(defaults);
    expect(document.documentElement.style.fontSize).toBe("100%");
});

it.each([90, 100, 110, 125] as const)("restores %s%% text and the selected grid after reloading", async textScale => {
  const store = await load();
  store.setViewSettings({ gridStep: 40, snapToGrid: false, showGrid: false, textScale });
  const selected = { gridStep: 40, snapToGrid: false, showGrid: false, textScale };
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(selected);
  expect(document.documentElement.style.fontSize).toBe(`${textScale}%`);
  expect((await load()).currentViewSettings()).toEqual(selected);
  expect(document.documentElement.style.fontSize).toBe(`${textScale}%`);
});

it("preserves valid saved fields when another field is invalid", async () => {
  localStorage.setItem(key, '{"gridStep":10,"snapToGrid":false,"showGrid":true,"textScale":null}');
  expect((await load()).currentViewSettings()).toEqual({ gridStep: 10, snapToGrid: false, showGrid: true, textScale: 100 });
});

it("permits session changes when browser storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
  const store = await load();
  expect(store.currentViewSettings()).toEqual(defaults);
  expect(() => store.setViewSettings({ gridStep: 10, textScale: 125 })).not.toThrow();
  expect(store.currentViewSettings()).toEqual({ ...defaults, gridStep: 10, textScale: 125 });
  expect(document.documentElement.style.fontSize).toBe("125%");
});
