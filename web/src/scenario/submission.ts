import type {
  Execution,
  ExperimentSubmission,
  Scenario,
  SweepSpec,
} from "../api/types";

export function buildComparison(
  baseline: Scenario,
  candidate: Scenario,
  execution: Execution,
): ExperimentSubmission {
  return {
    experiment: {
      schemaVersion: 1,
      execution,
      variants: [
        {
          id: "baseline",
          label: "Baseline",
          scenario: baseline,
          sweepParameter: null,
          sweepValue: null,
        },
        {
          id: "candidate",
          label: "Candidate",
          scenario: candidate,
          sweepParameter: null,
          sweepValue: null,
        },
      ],
    },
    sweep: null,
  };
}

export function buildSweep(
  base: Scenario,
  execution: Execution,
  sweep: SweepSpec,
): ExperimentSubmission {
  return {
    experiment: null,
    sweep: {
      schemaVersion: 1,
      execution,
      baseScenario: base,
      sweep,
    },
  };
}

export function assertExclusiveSubmissionMode(submission: ExperimentSubmission): void {
  if (submission.experiment !== null && submission.sweep !== null) {
    throw new Error("Choose either experiment or sweep mode, not both");
  }
  if (submission.experiment === null && submission.sweep === null) {
    throw new Error("Choose experiment or sweep mode");
  }
}
