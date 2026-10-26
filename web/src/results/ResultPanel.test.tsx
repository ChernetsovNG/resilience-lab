import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ExperimentResult,
  JobStatus as ExperimentJobStatus,
  MetricSummary,
  SweepSpec,
  VariantResult,
} from "../api/types";
import { ExperimentControls } from "../experiment/ExperimentControls";
import { JobStatus } from "../experiment/JobStatus";
import type { useExperimentJob } from "../experiment/useExperimentJob";
import { createDefaultExecution, createThreeServiceChain } from "../scenario/factory";
import { buildComparison, buildSweep } from "../scenario/submission";
import { ResultPanel } from "./ResultPanel";

function metric(mean: number): MetricSummary {
  return {
    mean,
    stdDev: null,
    ci95Low: null,
    ci95High: null,
    min: mean,
    max: mean,
  };
}

function variant(
  id: string,
  label: string,
  successRate: number,
  p95Ms: number,
  p99Ms: number,
  admitted: number,
  offered: number,
): VariantResult {
  return {
    id,
    label,
    sweepParameter: null,
    sweepValue: null,
    replications: [],
    aggregate: {
      pooledLatency: {
        all: { meanMs: (p95Ms + p99Ms) / 3, p95Ms, p99Ms },
        successful: null,
        failed: null,
      },
      successRate: metric(successRate),
      p95LatencyMs: metric(9_999),
      p99LatencyMs: metric(8_888),
      services: {
        checkout: {
          admittedAmplification: metric(admitted),
          offeredAmplification: metric(offered),
        },
      },
    },
  };
}

const result: ExperimentResult = {
  schemaVersion: 1,
  applicationVersion: "1.2.3",
  kslVersion: "R1.8.1",
  variants: [
    variant("baseline", "Baseline", 0.925, 120.5, 240.25, 1.25, 1.5),
    variant("candidate", "Candidate", 0.75, 450.5, 900.75, 2.5, 3.75),
  ],
};

function expectMetric(section: HTMLElement, label: string, value: string) {
  const term = within(section).getByText(label);
  expect(term.parentElement?.querySelector("dd")?.textContent).toBe(value);
}

describe("ResultPanel", () => {
  it("renders the job ID and actual aggregate metric paths for every variant", () => {
    render(<ResultPanel jobId="job-42" result={result} />);

    expect(screen.getByText("Job ID:")).toBeTruthy();
    expect(screen.getByText("job-42")).toBeTruthy();
    const baseline = screen.getByRole("region", { name: "Baseline metrics" });
    expectMetric(baseline, "Success rate", "92.50%");
    expectMetric(baseline, "Pooled all-latency p95", "120.50 ms");
    expectMetric(baseline, "Pooled all-latency p99", "240.25 ms");
    expectMetric(baseline, "checkout admitted amplification", "1.25×");
    expectMetric(baseline, "checkout offered amplification", "1.50×");
    expect(baseline.textContent).not.toContain("9999");
    expect(baseline.textContent).not.toContain("8888");

    const candidate = screen.getByRole("region", { name: "Candidate metrics" });
    expectMetric(candidate, "Success rate", "75.00%");
    expectMetric(candidate, "Pooled all-latency p95", "450.50 ms");
    expectMetric(candidate, "Pooled all-latency p99", "900.75 ms");
    expectMetric(candidate, "checkout admitted amplification", "2.50×");
    expectMetric(candidate, "checkout offered amplification", "3.75×");
  });

  it("renders unavailable metrics without inventing values", () => {
    const empty = variant("empty", "Empty", 0, 0, 0, 0, 0);
    empty.aggregate.pooledLatency.all = null;
    empty.aggregate.successRate = null;
    empty.aggregate.services.checkout.admittedAmplification = null;
    empty.aggregate.services.checkout.offeredAmplification = null;

    render(<ResultPanel jobId="job-empty" result={{ ...result, variants: [empty] }} />);

    const section = screen.getByRole("region", { name: "Empty metrics" });
    expectMetric(section, "Success rate", "N/A");
    expectMetric(section, "Pooled all-latency p95", "N/A");
    expectMetric(section, "Pooled all-latency p99", "N/A");
    expectMetric(section, "checkout admitted amplification", "N/A");
    expectMetric(section, "checkout offered amplification", "N/A");
  });

  it("keeps the job ID visible before a result arrives and reports errors", () => {
    const { rerender } = render(<ResultPanel jobId="job-pending" result={null} />);
    expect(screen.getByText("job-pending")).toBeTruthy();
    expect(screen.getByText("No result available.")).toBeTruthy();

    rerender(<ResultPanel jobId="job-pending" result={null} error="Experiment not found" />);
    expect(screen.getByRole("alert").textContent).toBe("Experiment not found");
  });

  it("renders structured submission issues", () => {
    render(
      <ResultPanel
        jobId={null}
        result={null}
        error="Experiment validation failed"
        issues={[{ path: "sweep.values[0]", message: "must be greater than zero" }]}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("sweep.values[0]");
    expect(screen.getByRole("alert").textContent).toContain("must be greater than zero");
  });

  it("shows retry lifecycle assumptions and downloaded-analysis guidance beside results", () => {
    render(<ResultPanel jobId="job-42" result={result} />);

    const assumptions = screen.getByRole("region", { name: "Model assumptions" });
    expect(assumptions.textContent).toContain("handlers remain occupied during retry/backoff");
    expect(assumptions.textContent).toContain("No cancellation or queue removal");
    expect(assumptions.textContent).toContain("Orphaned work continues");
    expect(assumptions.textContent).toContain("Late responses are discarded");
    expect(assumptions.textContent).toContain("fully drained");
    expect(assumptions.textContent).toContain("Downloaded analysis");
    expect(screen.getByTestId("result-download")).toBeTruthy();
  });
});

describe("JobStatus", () => {
  it.each<ExperimentJobStatus>(["QUEUED", "RUNNING", "COMPLETED", "FAILED"])(
    "mirrors backend state %s exactly",
    (status) => {
      render(<JobStatus job={{ id: `job-${status}`, status }} isRunning={status === "RUNNING"} />);
      expect(screen.getByRole("status").textContent).toBe(status);
    },
  );
});

describe("ExperimentControls", () => {
  it("builds one exclusive comparison or sweep submission from current editor state", () => {
    const baseline = createThreeServiceChain();
    const candidate = createThreeServiceChain();
    candidate.workload.arrivalRate = 25;
    const execution = createDefaultExecution();
    const sweep: SweepSpec = {
      parameter: "ARRIVAL_RATE",
      serviceId: null,
      linkId: null,
      values: [10, 20],
    };
    const controller: ReturnType<typeof useExperimentJob> = {
      jobId: null,
      job: null,
      result: null,
      submission: null,
      issues: [],
      isRunning: false,
      error: null,
      startComparison: vi.fn().mockResolvedValue(undefined),
      startSweep: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
    };
    render(
      <ExperimentControls
        editor={{ baseline, candidate, execution }}
        sweep={sweep}
        controller={controller}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    expect(controller.startComparison).toHaveBeenCalledTimes(1);
    expect(controller.startComparison).toHaveBeenCalledWith(
      buildComparison(baseline, candidate, execution),
    );
    expect(controller.startSweep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run sweep" }));
    expect(controller.startSweep).toHaveBeenCalledTimes(1);
    expect(controller.startSweep).toHaveBeenCalledWith(buildSweep(baseline, execution, sweep));
    expect(controller.startComparison).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate submissions while running and disables an unavailable sweep", () => {
    const baseline = createThreeServiceChain();
    const controller: ReturnType<typeof useExperimentJob> = {
      jobId: null,
      job: null,
      result: null,
      submission: null,
      issues: [],
      isRunning: true,
      error: null,
      startComparison: vi.fn(),
      startSweep: vi.fn(),
      reset: vi.fn(),
    };
    render(
      <ExperimentControls
        editor={{ baseline, candidate: baseline, execution: createDefaultExecution() }}
        controller={controller}
      />,
    );

    expect(screen.getByRole("button", { name: "Run comparison" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Run sweep" })).toHaveProperty("disabled", true);
  });
});
