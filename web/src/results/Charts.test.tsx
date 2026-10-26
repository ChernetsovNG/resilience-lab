import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExperimentResult, MetricSummary, VariantResult } from "../api/types";
import { ResultDownload } from "./ResultDownload";
import { ResultPanel } from "./ResultPanel";
import { SweepChart } from "./SweepChart";
import { SweepControls } from "./SweepControls";
import { VariantComparisonChart } from "./VariantComparisonChart";

const { downloadJson } = vi.hoisted(() => ({ downloadJson: vi.fn() }));

vi.mock("../io/ScenarioIo", () => ({ downloadJson }));

function metric(
  mean: number,
  ci95Low: number | null = null,
  ci95High: number | null = null,
): MetricSummary {
  return { mean, stdDev: null, ci95Low, ci95High, min: mean, max: mean };
}

function variant(
  id: string,
  label: string,
  successRate: number,
  p95Ms: number,
  p99Ms: number,
  admitted: number,
): VariantResult {
  return {
    id,
    label,
    sweepParameter: null,
    sweepValue: null,
    replications: [
      {
        arrivalTimesMs: [0],
        allLatenciesMs: [p95Ms],
        successfulLatenciesMs: [p95Ms],
        failedLatenciesMs: [],
        originalArrivals: 1,
        successes: 1,
        failures: 0,
        services: {
          checkout: {
            offeredAttempts: 1,
            admittedAttempts: 1,
            timeouts: 0,
            retries: 0,
            failures: 0,
            queueRejections: 0,
            handlerUtilization: 0.5,
            meanQueueLength: 0,
            p95QueueLength: 0,
          },
        },
      },
    ],
    aggregate: {
      pooledLatency: {
        all: { meanMs: p95Ms, p95Ms, p99Ms },
        successful: null,
        failed: null,
      },
      successRate: metric(successRate),
      p95LatencyMs: metric(p95Ms),
      p99LatencyMs: metric(p99Ms),
      services: {
        checkout: {
          admittedAmplification: metric(admitted),
          offeredAmplification: metric(admitted + 0.25),
        },
      },
    },
  };
}

const baseline = variant("baseline", "Baseline", 0.925, 120.5, 240.25, 1.25);
const candidate = variant("candidate", "Candidate", 0.75, 450.5, 900.75, 2.5);
const result: ExperimentResult = {
  schemaVersion: 1,
  applicationVersion: "1.2.3",
  kslVersion: "R1.8.1",
  variants: [baseline, candidate],
};

describe("VariantComparisonChart", () => {
  it("describes baseline and candidate aggregates with their numeric values", () => {
    render(<VariantComparisonChart variants={[baseline, candidate]} />);

    const figure = screen.getByRole("figure", { name: "Variant comparison" });
    for (const text of [
      "Baseline",
      "Candidate",
      "92.50%",
      "75.00%",
      "120.50 ms",
      "450.50 ms",
      "240.25 ms",
      "900.75 ms",
      "1.25×",
      "2.50×",
    ]) {
      expect(figure.textContent).toContain(text);
    }
  });

  it("shows 95% intervals when present and identifies missing replication intervals", () => {
    baseline.aggregate.successRate = metric(0.925, 0.88, 0.96);
    baseline.aggregate.services.checkout.admittedAmplification = metric(1.25, 1.1, 1.4);

    render(<VariantComparisonChart variants={[baseline, candidate]} />);

    const figure = screen.getByRole("figure", { name: "Variant comparison" });
    expect(figure.textContent).toContain("95% CI [88.00%, 96.00%]");
    expect(figure.textContent).toContain("95% CI [1.10×, 1.40×]");
    expect(figure.textContent).toContain("Candidate: not enough replications");
  });
});

describe("SweepControls", () => {
  it("accepts an arrival-rate list in order without a target", () => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Sweep values"), {
      target: { value: "25, 50, 100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));

    expect(onChange).toHaveBeenCalledWith({
      parameter: "ARRIVAL_RATE",
      serviceId: null,
      linkId: null,
      values: [25, 50, 100],
    });
  });

  it("requires a link target and preserves the ordered values", () => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Sweep parameter"), {
      target: { value: "LINK_TIMEOUT" },
    });
    fireEvent.change(screen.getByLabelText("Sweep values"), {
      target: { value: "25, 50, 100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Link ID is required");

    fireEvent.change(screen.getByLabelText("Link ID"), { target: { value: "api-db" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(onChange).toHaveBeenCalledWith({
      parameter: "LINK_TIMEOUT",
      serviceId: null,
      linkId: "api-db",
      values: [25, 50, 100],
    });
  });

  it("requires a service target for degradation sweeps", () => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Sweep parameter"), {
      target: { value: "DEGRADATION_MULTIPLIER" },
    });
    fireEvent.change(screen.getByLabelText("Sweep values"), {
      target: { value: "25, 50, 100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Service ID"), { target: { value: "checkout" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(onChange).toHaveBeenCalledWith({
      parameter: "DEGRADATION_MULTIPLIER",
      serviceId: "checkout",
      linkId: null,
      values: [25, 50, 100],
    });
  });

  it("rejects non-finite values and non-integer max attempts", () => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);
    const values = screen.getByLabelText("Sweep values");

    fireEvent.change(values, { target: { value: "25, Infinity, 100" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("finite numbers");

    fireEvent.change(screen.getByLabelText("Sweep parameter"), {
      target: { value: "MAX_ATTEMPTS" },
    });
    fireEvent.change(screen.getByLabelText("Link ID"), { target: { value: "api-db" } });
    fireEvent.change(values, { target: { value: "1, 2.5, 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("integers");
  });
});

describe("SweepChart", () => {
  const sweepVariants = [25, 50, 100].map((value, index) => ({
    ...variant(`variant-${[900, 100, 500][index]}`, `Point ${index}`, 0.9 - index * 0.1, 120 + index * 10, 240, 1.25 + index),
    sweepParameter: "ARRIVAL_RATE" as const,
    sweepValue: value,
  }));

  it("uses only sweep metadata for all three x values and supports metric selection", () => {
    render(<SweepChart variants={[sweepVariants[2], sweepVariants[0], sweepVariants[1]]} />);

    const figure = screen.getByRole("figure", { name: "Parameter sweep" });
    const points = within(figure).getAllByRole("listitem");
    expect(points.map((point) => point.textContent)).toEqual([
      "25: 90.00%",
      "50: 80.00%",
      "100: 70.00%",
    ]);
    expect(figure.textContent).not.toContain("900");

    fireEvent.change(screen.getByLabelText("Sweep metric"), { target: { value: "p95" } });
    expect(points.map((point) => point.textContent)).toEqual([
      "25: 120.00 ms",
      "50: 130.00 ms",
      "100: 140.00 ms",
    ]);

    fireEvent.change(screen.getByLabelText("Sweep metric"), {
      target: { value: "amplification" },
    });
    expect(points.map((point) => point.textContent)).toEqual([
      "25: 1.25×",
      "50: 2.25×",
      "100: 3.25×",
    ]);
  });
});

describe("ResultDownload and ResultPanel integration", () => {
  it("downloads the complete result document", () => {
    render(<ResultDownload result={result} />);

    fireEvent.click(screen.getByTestId("result-download"));

    expect(downloadJson).toHaveBeenCalledWith("experiment-result.json", result);
    expect(downloadJson.mock.calls[0][1].variants[0].replications).toHaveLength(1);
  });

  it("integrates comparison visualization and download into the result panel", () => {
    render(<ResultPanel jobId="job-42" result={result} />);

    expect(screen.getByRole("figure", { name: "Variant comparison" })).toBeTruthy();
    expect(screen.getByTestId("result-download")).toBeTruthy();
  });
});
