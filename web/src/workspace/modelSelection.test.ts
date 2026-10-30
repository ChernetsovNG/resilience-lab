import { afterEach, expect, it, vi } from "vitest";
import type { DocumentEntry } from "../api/apiTypes";
import { experimentsForModel, preferredExperiment, readSelection, rememberSelection } from "./modelSelection";

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

it("remembers the model and an independent last experiment per model", () => {
  rememberSelection("checkout/checkout.model.json", "questions/compare.experiment.json");
  rememberSelection("retry/retry.model.json", "retry/retry.experiment.json");
  expect(readSelection()).toEqual({ model: "retry/retry.model.json", experiments: {
    "checkout/checkout.model.json": "questions/compare.experiment.json", "retry/retry.model.json": "retry/retry.experiment.json",
  } });
});

it("ignores corrupt preferences", () => {
  localStorage.setItem("resilience-lab.workspace-selection", "{");
  expect(readSelection()).toEqual({ model: null, experiments: {} });
});

it("allows navigation when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
  expect(readSelection()).toEqual({ model: null, experiments: {} });
  expect(() => rememberSelection("model.model.json", "question.experiment.json")).not.toThrow();
});
