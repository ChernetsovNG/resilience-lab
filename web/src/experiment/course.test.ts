import { afterEach, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { catalog, experiment, model } from "../test/fixtures";
import { courseData, faultLabel, runConditions } from "./course";

afterEach(() => { setLanguage("en"); localStorage.clear(); });

it("projects run phases and interpolates load at both run boundaries", () => {
  const draft = structuredClone(model);
  draft.blocks.client.params.load = { points: [
    { time: "10s", rate: "600/min" }, { time: "50s", rate: "90/s" }, { time: "100s", rate: "0.11/ms" },
  ] };
  const run = { ...experiment, execution: { ...experiment.execution, warmup: "10s", measurement: "1min" } };
  const data = courseData(draft, run, catalog);
  expect(data.warmupMs).toBe(10_000);
  expect(data.endMs).toBe(70_000);
  expect(data.loads[0].points).toEqual([
    { timeMs: 0, rate: 10 }, { timeMs: 10_000, rate: 10 }, { timeMs: 50_000, rate: 90 }, { timeMs: 70_000, rate: 98 },
  ]);
});

it("keeps the nearest intensity outside a profile and handles zero load", () => {
  const draft = structuredClone(model);
  draft.blocks.client.params.load = { points: [{ time: "20ms", rate: "0/s" }] };
  expect(courseData(draft, experiment, catalog).loads[0].points).toEqual([
    { timeMs: 0, rate: 0 }, { timeMs: 20, rate: 0 }, { timeMs: 1000, rate: 0 },
  ]);
});

it("labels replicas and copied connections and marks their owning diagram elements only", () => {
  const run = { ...experiment, faults: [
    { target: "gateway#2", from: "200ms", to: "700ms", kind: "slowdown", multiplier: 6 },
    { target: "gateway-to-middle#2", from: "0ms", to: "1s", kind: "unavailable" },
    { target: "unknown#2", from: "0ms", to: "1s", kind: "blackhole" },
  ] };
  const grouped = structuredClone(model);
  grouped.blocks.gateway.params.replicas = 2;
  const data = courseData(grouped, run, catalog);
  expect(data.faults.map(fault => [fault.index, fault.elementId, fault.target])).toEqual([
    [0, "gateway", "gateway#2"], [1, "gateway-to-middle", "gateway#2 → middle"], [2, null, "unknown#2"],
  ]);
  expect(data.faults[0].label).toBe("gateway#2 · Slowdown 6× · 0.2–0.7 s");
});

it.each([
  [{ kind: "slowdown", multiplier: 6, delay: "250ms" }, "Slowdown 6× +250 ms"],
  [{ kind: "slowdown", delay: "1s" }, "Slowdown +1,000 ms"],
  [{ kind: "errors", failureRate: "25%" }, "Errors 25%"],
  [{ kind: "unavailable" }, "Fast unavailability"],
  [{ kind: "blackhole" }, "Black hole"],
  [{ kind: "capacityLoss", capacity: 0 }, "Capacity loss: 0 slots remaining"],
])("describes fault parameters: %j", (parameters, expected) => {
  expect(faultLabel({ target: "dependency", from: "0s", to: "1s", ...parameters }, model, catalog))
    .toBe(`dependency · ${expected} · 0–1 s`);
});

it("summarizes constant and changing load with every fault in both languages", () => {
  expect(runConditions(model, experiment, catalog)).toBe("Load 120 RPS; faults: dependency · Slowdown 6× · 0.2–0.7 s");
  const draft = structuredClone(model);
  draft.blocks.client.params.load = { points: [{ time: "0s", rate: "10/s" }, { time: "1s", rate: "90/s" }] };
  const run = { ...experiment, faults: [...experiment.faults, { target: "gateway", kind: "blackhole", from: "0s", to: "1s" }] };
  expect(runConditions(draft, run, catalog)).toBe("Load from 10 RPS to 90 RPS; faults: dependency · Slowdown 6× · 0.2–0.7 s; gateway · Black hole · 0–1 s");
  setLanguage("ru");
  expect(runConditions(draft, run, catalog)).toBe("Нагрузка от 10 RPS до 90 RPS; отказы: dependency · Замедление 6× · 0,2–0,7 с; gateway · Чёрная дыра · 0–1 с");
});

it("does not invent a curve for invalid draft points or crash on unknown fault kinds", () => {
  const draft = structuredClone(model);
  draft.blocks.client.params.load = { points: [{ time: "1s", rate: "10/s" }, { time: "0s", rate: "20/s" }] };
  expect(courseData(draft, experiment, catalog).loads[0].points).toEqual([]);
  expect(faultLabel({ target: "dependency", kind: "future", from: "bad", to: "1s" }, model, catalog)).toContain("future");
});

it("does not mark a group or edge for a replica outside its effective count", () => {
  const run = { ...experiment, faults: [
    { target: "gateway#2", from: "0s", to: "1s", kind: "unavailable" },
    { target: "gateway-to-middle#2", from: "0s", to: "1s", kind: "blackhole" },
  ] };
  expect(courseData(model, run, catalog).faults.map(fault => fault.elementId)).toEqual([null, null]);
});

it("treats object prototype names as unknown targets", () => {
  const run = { ...experiment, faults: [{ target: "constructor", from: "0s", to: "1s", kind: "blackhole" }] };
  expect(courseData(model, run, catalog).faults[0].elementId).toBeNull();
});

it.each([undefined, 1])("does not mark replica #1 when no group is expanded (replicas=%s)", replicas => {
  const draft = structuredClone(model);
  if (replicas !== undefined) draft.blocks.gateway.params.replicas = replicas;
  const run = { ...experiment, faults: [
    { target: "gateway#1", from: "0s", to: "1s", kind: "unavailable" },
    { target: "gateway-to-middle#1", from: "0s", to: "1s", kind: "blackhole" },
  ] };
  expect(courseData(draft, run, catalog).faults.map(fault => fault.elementId)).toEqual([null, null]);
});
