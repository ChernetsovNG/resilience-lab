import { afterEach, expect, it, vi } from "vitest";
import type { DocumentEntry } from "../api/apiTypes";
import { experimentsForModel, preferredExperiment, preferredModel, readSelection, rememberSelection } from "./modelSelection";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const entries = [
  { path: "checkout/checkout.model.json", kind: "MODEL", version: "m", modelRef: null },
  { path: "checkout/grid.experiment.json", kind: "EXPERIMENT", version: "g", modelRef: "./checkout.model.json" },
  { path: "questions/compare.experiment.json", kind: "EXPERIMENT", version: "c", modelRef: "../checkout/checkout.model.json" },
  { path: "other/wrong.experiment.json", kind: "EXPERIMENT", version: "w", modelRef: "checkout.model.json" },
  { path: "broken.experiment.json", kind: "EXPERIMENT", version: "b", modelRef: null },
] as DocumentEntry[];

it("groups experiments by resolved modelRef, including questions in another directory", () => {
  expect(experimentsForModel(entries, "checkout/checkout.model.json")).toEqual([
    "checkout/grid.experiment.json", "questions/compare.experiment.json",
  ]);
});

it("prefers the model's last experiment and falls back to the first path when it disappeared", () => {
  expect(preferredExperiment(entries, "checkout/checkout.model.json", "questions/compare.experiment.json")).toBe("questions/compare.experiment.json");
  expect(preferredExperiment(entries, "checkout/checkout.model.json", "deleted.experiment.json")).toBe("checkout/grid.experiment.json");
  expect(preferredExperiment(entries, "empty.model.json")).toBeNull();
});

it("opens the matching main experiment unless a surviving last choice exists", () => {
  const withMain = [...entries,
    { path: "checkout/checkout-grid.experiment.json", kind: "EXPERIMENT", version: "grid", modelRef: "./checkout.model.json" },
    { path: "checkout/checkout.experiment.json", kind: "EXPERIMENT", version: "main", modelRef: "./checkout.model.json" },
    { path: "other/checkout.experiment.json", kind: "EXPERIMENT", version: "other", modelRef: "../checkout/checkout.model.json" },
  ] as DocumentEntry[];
  expect(preferredExperiment(withMain, "checkout/checkout.model.json")).toBe("checkout/checkout.experiment.json");
  expect(preferredExperiment(withMain, "checkout/checkout.model.json", "deleted.experiment.json")).toBe("checkout/checkout.experiment.json");
  expect(preferredExperiment(withMain, "checkout/checkout.model.json", "checkout/grid.experiment.json")).toBe("checkout/grid.experiment.json");
});

it("remembers the model and an independent last experiment per model", () => {
  rememberSelection("checkout/checkout.model.json", "questions/compare.experiment.json");
  rememberSelection("retry/retry.model.json", "retry/retry.experiment.json");
  expect(readSelection()).toEqual({ model: "retry/retry.model.json", experiments: {
    "checkout/checkout.model.json": "questions/compare.experiment.json", "retry/retry.model.json": "retry/retry.experiment.json",
  }, recentModels: ["retry/retry.model.json", "checkout/checkout.model.json"] });
});

it("chooses the most recently opened remaining model, then the first path, or an empty workspace", () => {
  rememberSelection("checkout/checkout.model.json", "checkout/grid.experiment.json");
  rememberSelection("z.model.json", "z.experiment.json");
  rememberSelection("checkout/checkout.model.json", "questions/compare.experiment.json");
  rememberSelection("deleted.model.json", "deleted.experiment.json");
  const remaining = [...entries, { path: "z.model.json", kind: "MODEL" as const, version: "z", modelRef: null }];
  expect(preferredModel(remaining, readSelection().recentModels)).toBe("checkout/checkout.model.json");
  expect(preferredModel(remaining.filter(entry => entry.path !== "checkout/checkout.model.json"), readSelection().recentModels)).toBe("z.model.json");
  expect(preferredModel(remaining, ["deleted.model.json"])).toBe("checkout/checkout.model.json");
  expect(preferredModel([])).toBeNull();
});

it("ignores corrupt preferences", () => {
  localStorage.setItem("resilience-lab.workspace-selection", "{");
  expect(readSelection()).toEqual({ model: null, experiments: {}, recentModels: [] });
});

it("allows navigation when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
  expect(readSelection()).toEqual({ model: null, experiments: {}, recentModels: [] });
  expect(() => rememberSelection("model.model.json", "question.experiment.json")).not.toThrow();
});
