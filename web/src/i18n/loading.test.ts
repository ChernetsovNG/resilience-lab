import { afterEach, beforeEach, expect, it, vi } from "vitest";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => {
  vi.doUnmock("./en.json");
  vi.doUnmock("./ru.json");
  localStorage.clear();
});

it("loads only the selected catalog at startup", async () => {
  let englishLoads = 0, russianLoads = 0;
  vi.doMock("./en.json", () => { englishLoads++; return vi.importActual("./en.json"); });
  vi.doMock("./ru.json", () => { russianLoads++; return vi.importActual("./ru.json"); });
  const fresh = await import("./index");
  await fresh.initializeLanguage();
  expect(fresh.t("app.topBar.save")).toBe("Save");
  expect(localStorage.getItem("resilience-lab.language")).toBeNull();
  expect(englishLoads).toBe(1);
  expect(russianLoads).toBe(0);
});

it("retains the current messages until the next catalog loads, loading each language once", async () => {
  const fresh = await import("./index");
  await fresh.setLanguage("en");
  const gate = deferred();
  let loads = 0;
  vi.doMock("./ru.json", async () => { loads++; await gate.promise; return vi.importActual("./ru.json"); });
  const changed = vi.fn();
  const unsubscribe = fresh.subscribeLanguage(changed);
  const first = fresh.setLanguage("ru"), second = fresh.setLanguage("ru");
  try {
    expect(fresh.t("app.topBar.save")).toBe("Save");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("resilience-lab.language")).toBe("en");
    expect(changed).not.toHaveBeenCalled();
  } finally { gate.resolve(); }
  await Promise.all([first, second]);
  expect(fresh.t("app.topBar.save")).toBe("Сохранить");
  expect(document.documentElement.lang).toBe("ru");
  expect(changed).toHaveBeenCalledTimes(1);
  await fresh.setLanguage("en");
  await fresh.setLanguage("ru");
  expect(loads).toBe(1);
  unsubscribe();
});

it("keeps the most recent choice when a previous catalog request finishes later", async () => {
  const fresh = await import("./index");
  await fresh.setLanguage("en");
  const gate = deferred();
  vi.doMock("./ru.json", async () => { await gate.promise; return vi.importActual("./ru.json"); });
  const pending = fresh.setLanguage("ru");
  await fresh.setLanguage("en");
  gate.resolve();
  await pending;
  expect(fresh.t("app.topBar.save")).toBe("Save");
  expect(document.documentElement.lang).toBe("en");
  expect(localStorage.getItem("resilience-lab.language")).toBe("en");
});

it("retains the previous language after a failed load and permits retry", async () => {
  const fresh = await import("./index");
  await fresh.setLanguage("en");
  vi.doMock("./ru.json", () => { throw new Error("catalog unavailable"); });
  await expect(fresh.setLanguage("ru")).rejects.toThrow();
  expect(fresh.t("app.topBar.save")).toBe("Save");
  expect(localStorage.getItem("resilience-lab.language")).toBe("en");
  vi.doMock("./ru.json", () => vi.importActual("./ru.json"));
  await fresh.setLanguage("ru");
  expect(fresh.t("app.topBar.save")).toBe("Сохранить");
});
