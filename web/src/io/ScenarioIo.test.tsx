import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSubmission } from "../api/client";
import type { Execution, ExperimentDocument, Scenario, ValidationIssue } from "../api/types";
import { createDefaultExecution, createThreeServiceChain } from "../scenario/factory";
import { ScenarioIo } from "./ScenarioIo";
import { ScenarioIoControls } from "./ScenarioIoControls";

vi.mock("../api/client", () => ({ validateSubmission: vi.fn() }));

const validateMock = vi.mocked(validateSubmission);

interface ImportState {
  scenario: Scenario;
  execution: Execution;
  issues: ValidationIssue[];
}

function harness(initialScenario = createThreeServiceChain(), initialExecution = createDefaultExecution()) {
  const state: ImportState = {
    scenario: initialScenario,
    execution: initialExecution,
    issues: [],
  };
  const io = new ScenarioIo({
    getExecution: () => state.execution,
    replaceScenario: (scenario) => {
      state.scenario = scenario;
    },
    replaceExperiment: (scenario, execution) => {
      state.scenario = scenario;
      state.execution = execution;
    },
    onIssues: (issues) => {
      state.issues = issues;
    },
  });
  return { state, io };
}

function jsonFile(value: unknown): File {
  return new File([JSON.stringify(value)], "scenario.json", { type: "application/json" });
}

function documentFor(scenario: Scenario, execution: Execution): ExperimentDocument {
  return {
    schemaVersion: 1,
    execution,
    variants: [
      {
        id: "imported",
        label: "imported",
        scenario,
        sweepParameter: null,
        sweepValue: null,
      },
    ],
  };
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("ScenarioIo", () => {
  beforeEach(() => {
    validateMock.mockReset();
    validateMock.mockResolvedValue({ valid: true, issues: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("validates and imports a raw scenario with the current execution", async () => {
    const currentExecution = { ...createDefaultExecution(), seed: 777 };
    const previous = createThreeServiceChain();
    const imported = createThreeServiceChain();
    imported.workload.arrivalRate = 25;
    const { state, io } = harness(previous, currentExecution);

    await expect(io.importScenario(jsonFile(imported))).resolves.toEqual(imported);

    expect(validateMock).toHaveBeenCalledWith({
      experiment: documentFor(imported, currentExecution),
      sweep: null,
    });
    expect(state.scenario).toEqual(imported);
    expect(state.execution).toBe(currentExecution);
  });

  it("imports a full document and preserves its execution and seed", async () => {
    const imported = createThreeServiceChain();
    imported.services[0].handlers = 9;
    const execution = { ...createDefaultExecution(), seed: 987_654_321, replications: 11 };
    const document = documentFor(imported, execution);
    document.variants.push({ ...document.variants[0], id: "other", label: "Other" });
    const { state, io } = harness();

    await expect(io.importExperimentDocument(jsonFile(document))).resolves.toEqual({
      scenario: imported,
      execution,
    });
    expect(validateMock).toHaveBeenCalledWith({ experiment: document, sweep: null });
    expect(state.scenario).toEqual(imported);
    expect(state.execution).toEqual(execution);
    expect(state.execution.seed).toBe(987_654_321);
  });

  it("uses the first full-document variant when no imported variant exists", async () => {
    const first = createThreeServiceChain();
    const execution = { ...createDefaultExecution(), seed: 1234 };
    const document = documentFor(first, execution);
    document.variants[0].id = "first";
    const { state, io } = harness();

    const result = await io.importExperimentDocument(jsonFile(document));

    expect(result.scenario).toEqual(first);
    expect(state.scenario).toEqual(first);
  });

  it("rejects ambiguous variants without replacing state", async () => {
    const previous = createThreeServiceChain();
    const execution = { ...createDefaultExecution(), seed: 555 };
    const document = documentFor(previous, execution);
    document.variants[0].id = "first";
    document.variants.push({ ...document.variants[0], id: "second" });
    const { state, io } = harness(previous, execution);

    await expect(io.importExperimentDocument(jsonFile(document))).rejects.toThrow("ambiguous");

    expect(validateMock).not.toHaveBeenCalled();
    expect(state.scenario).toBe(previous);
    expect(state.execution).toBe(execution);
    expect(state.issues[0].message).toContain("ambiguous");
  });

  it("rejects a malformed document with issues instead of replacing state", async () => {
    const previous = createThreeServiceChain();
    const execution = createDefaultExecution();
    const { state, io } = harness(previous, execution);

    await expect(io.importExperimentDocument(jsonFile(null))).rejects.toThrow("Experiment document");

    expect(validateMock).not.toHaveBeenCalled();
    expect(state.scenario).toBe(previous);
    expect(state.execution).toBe(execution);
    expect(state.issues).toHaveLength(1);
  });

  it("shows backend issues and preserves scenario and execution for unknown fields", async () => {
    const previous = createThreeServiceChain();
    const execution = { ...createDefaultExecution(), seed: 999 };
    const document = { ...documentFor(createThreeServiceChain(), execution), unknownField: true };
    const issues = [{ path: "experiment.unknownField", message: "Unknown field" }];
    validateMock.mockResolvedValue({ valid: false, issues });
    const { state, io } = harness(previous, execution);

    await expect(io.importExperimentDocument(jsonFile(document))).rejects.toThrow("Invalid experiment");

    expect(state.scenario).toBe(previous);
    expect(state.execution).toBe(execution);
    expect(state.issues).toEqual(issues);
  });

  it("does not replace state when raw scenario validation fails", async () => {
    const previous = createThreeServiceChain();
    const execution = createDefaultExecution();
    const issues = [{ path: "variants[0].scenario.workload.arrivalRate", message: "must be positive" }];
    validateMock.mockResolvedValue({ valid: false, issues });
    const { state, io } = harness(previous, execution);

    await expect(io.importScenario(jsonFile(createThreeServiceChain()))).rejects.toThrow("Invalid scenario");

    expect(state.scenario).toBe(previous);
    expect(state.execution).toBe(execution);
    expect(state.issues).toEqual(issues);
  });

  it("exports a full document through the UI and reimports scenario, execution, and seed", async () => {
    const scenario = createThreeServiceChain();
    scenario.services[0].queueCapacity = 7;
    const execution = { ...createDefaultExecution(), seed: 864_209, measurementMs: 5000 };
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return "blob:experiment";
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <ScenarioIoControls
        scenario={scenario}
        execution={execution}
        replaceScenario={vi.fn()}
        replaceExperiment={vi.fn()}
        onIssues={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export experiment" }));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const exported = JSON.parse(await blobText(blob)) as unknown;
    expect(exported).toEqual(documentFor(scenario, execution));

    const { state, io } = harness();
    await io.importExperimentDocument(jsonFile(exported));
    expect(state.scenario).toEqual(scenario);
    expect(state.execution).toEqual(execution);
    expect(state.execution.seed).toBe(864_209);
  });
});
