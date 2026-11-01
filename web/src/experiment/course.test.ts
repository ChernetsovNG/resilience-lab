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
    [0, "gateway", "Service gateway, replica 2"],
    [1, "gateway-to-middle", "Connection gateway → middle (gateway-to-middle), from replica 2"],
    [2, null, "unknown, replica 2"],
  ]);
  expect(data.faults[0].label).toBe("Service gateway, replica 2 · Slowdown 6× · 200–700 ms");
});

it.each([
  [{ kind: "slowdown", multiplier: 6, delay: "250ms" }, "Slowdown 6× +250 ms"],
  [{ kind: "slowdown", delay: "1s" }, "Slowdown +1 s"],
  [{ kind: "errors", failureRate: "25%" }, "Errors 25%"],
  [{ kind: "unavailable" }, "Fast unavailability"],
  [{ kind: "blackhole" }, "Black hole"],
  [{ kind: "capacityLoss", capacity: 0 }, "Capacity loss: 0 available"],
])("describes fault parameters: %j", (parameters, expected) => {
  expect(faultLabel({ target: "dependency", from: "0s", to: "1s", ...parameters }, model, catalog))
    .toBe(`Service dependency · ${expected} · 0–1 s`);
});

it("summarizes constant and changing load with every fault in both languages", () => {
  expect(runConditions(model, experiment, catalog)).toBe("Load 120 RPS; faults: Service dependency · Slowdown 6× · 200–700 ms");
  const draft = structuredClone(model);
  draft.blocks.client.params.load = { points: [{ time: "0s", rate: "10/s" }, { time: "1s", rate: "90/s" }] };
  const run = { ...experiment, faults: [...experiment.faults, { target: "gateway", kind: "blackhole", from: "0s", to: "1s" }] };
  expect(runConditions(draft, run, catalog)).toBe("Load from 10 RPS to 90 RPS; faults: Service dependency · Slowdown 6× · 200–700 ms; Service gateway · Black hole · 0–1 s");
  setLanguage("ru");
  expect(runConditions(draft, run, catalog)).toBe("Нагрузка от 10 RPS до 90 RPS; отказы: Сервис dependency · Замедление 6× · 200–700 мс; Сервис gateway · Чёрная дыра · 0–1 с");
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


it.each([
  ["en", "2min", "3min", "2–3 min", "+1,500 ms"],
  ["ru", "2min", "3min", "2–3 мин", "+1 500 мс"],
  ["en", "1500ms", "2s", "1,500 ms–2 s", "+1,500 ms"],
  ["ru", "1500ms", "2s", "1 500 мс–2 с", "+1 500 мс"],
] as const)("preserves chosen duration units in %s fault labels and run conditions (%s to %s)", (locale, from, to, interval, delay) => {
  setLanguage(locale);
  const fault = { target: "dependency", kind: "slowdown", from, to, delay: "1500ms" };
  const label = faultLabel(fault, model, catalog);
  expect(label).toContain(interval);
  expect(label).toContain(delay);
  const run = { ...experiment, execution: { ...experiment.execution, measurement: "5min" }, faults: [fault] };
  expect(runConditions(model, run, catalog)).toContain(interval);
  expect(runConditions(model, run, catalog)).toContain(delay);
});
