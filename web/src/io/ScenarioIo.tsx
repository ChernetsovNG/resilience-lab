import { ApiError, validateSubmission } from "../api/client";
import type {
  Execution,
  ExperimentDocument,
  ExperimentVariant,
  Scenario,
  ValidationIssue,
} from "../api/types";

interface ScenarioIoOptions {
  getExecution: () => Execution;
  replaceScenario: (scenario: Scenario) => void;
  replaceExperiment: (scenario: Scenario, execution: Execution) => void;
  onIssues: (issues: ValidationIssue[]) => void;
}

export class ScenarioImportError extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = "ScenarioImportError";
    this.issues = issues;
  }
}

export function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export class ScenarioIo {
  private readonly options: ScenarioIoOptions;

  constructor(options: ScenarioIoOptions) {
    this.options = options;
  }

  async importScenario(file: File): Promise<Scenario> {
    const scenario = await this.readJson(file);
    const experiment = this.wrapImported(scenario as Scenario, this.options.getExecution());
    await this.validate(experiment, "Invalid scenario");
    this.options.onIssues([]);
    this.options.replaceScenario(scenario as Scenario);
    return scenario as Scenario;
  }

  async importExperimentDocument(file: File): Promise<{ scenario: Scenario; execution: Execution }> {
    const value = await this.readJson(file);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.reject("Experiment document must be an object", "$");
    }
    const experiment = value as ExperimentDocument;
    if (experiment.schemaVersion !== 1) {
      this.reject("Unsupported experiment schemaVersion", "schemaVersion");
    }
    const variant = this.selectVariant(experiment.variants);
    await this.validate(experiment, "Invalid experiment");
    this.options.onIssues([]);
    this.options.replaceExperiment(variant.scenario, experiment.execution);
    return { scenario: variant.scenario, execution: experiment.execution };
  }

  private wrapImported(scenario: Scenario, execution: Execution): ExperimentDocument {
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

  private selectVariant(variants: ExperimentVariant[]): ExperimentVariant {
    if (!Array.isArray(variants)) {
      this.reject("Experiment variants must be an array", "variants");
    }
    const imported = variants.filter((variant) => variant.id === "imported" || variant.label === "imported");
    if (imported.length === 1) return imported[0];
    if (imported.length === 0 && variants.length === 1) return variants[0];
    this.reject("Experiment variants are ambiguous without one imported variant", "variants");
  }

  private async validate(experiment: ExperimentDocument, message: string): Promise<void> {
    try {
      const report = await validateSubmission({ experiment, sweep: null });
      if (!report.valid) {
        const issues = report.issues.length > 0 ? report.issues : [{ path: "$", message }];
        this.options.onIssues(issues);
        throw new ScenarioImportError(message, issues);
      }
    } catch (error) {
      if (error instanceof ScenarioImportError) throw error;
      const issues =
        error instanceof ApiError && error.issues.length > 0
          ? error.issues
          : [{ path: "$", message: error instanceof Error ? error.message : message }];
      this.options.onIssues(issues);
      throw new ScenarioImportError(message, issues);
    }
  }

  private async readJson(file: File): Promise<unknown> {
    try {
      return JSON.parse(await file.text()) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read JSON";
      this.reject(message, "$");
    }
  }

  private reject(message: string, path: string): never {
    const issues = [{ path, message }];
    this.options.onIssues(issues);
    throw new ScenarioImportError(message, issues);
  }
}
