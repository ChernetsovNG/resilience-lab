import { describe, expect, it } from "vitest";
import { createDefaultExecution, createThreeServiceChain } from "./factory";
import {
  assertExclusiveSubmissionMode,
  buildComparison,
  buildSweep,
} from "./submission";
import type { ExperimentSubmission, SweepSpec } from "../api/types";

describe("experiment submission builders", () => {
  it("builds exactly baseline and candidate variants without a sweep", () => {
    const baseline = createThreeServiceChain();
    const candidate = createThreeServiceChain();
    const execution = createDefaultExecution();

    const submission = buildComparison(baseline, candidate, execution);

    expect(submission.sweep).toBeNull();
    expect(submission.experiment).toEqual({
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
    });
    expect(Object.keys(submission)).toEqual(["experiment", "sweep"]);
  });

  it("builds exactly one sweep document without an experiment", () => {
    const base = createThreeServiceChain();
    const execution = createDefaultExecution();
    const sweep = {
      parameter: "ARRIVAL_RATE",
      serviceId: null,
      linkId: null,
      values: [5, 10],
    } satisfies SweepSpec;

    const submission = buildSweep(base, execution, sweep);

    expect(submission.experiment).toBeNull();
    expect(submission.sweep).toEqual({
      schemaVersion: 1,
      execution,
      baseScenario: base,
      sweep,
    });
    expect(Object.keys(submission)).toEqual(["experiment", "sweep"]);
  });

  it("rejects simultaneous experiment and sweep modes", () => {
    const comparison = buildComparison(
      createThreeServiceChain(),
      createThreeServiceChain(),
      createDefaultExecution(),
    );
    const sweep = buildSweep(createThreeServiceChain(), createDefaultExecution(), {
      parameter: "ARRIVAL_RATE",
      serviceId: null,
      linkId: null,
      values: [5, 10],
    });
    const both: ExperimentSubmission = {
      experiment: comparison.experiment,
      sweep: sweep.sweep,
    };

    expect(() => assertExclusiveSubmissionMode(both)).toThrow(
      "Choose either experiment or sweep mode, not both",
    );
    expect(() => assertExclusiveSubmissionMode({ experiment: null, sweep: null })).toThrow(
      "Choose experiment or sweep mode",
    );
  });
});
