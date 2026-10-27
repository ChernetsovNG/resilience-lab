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

  it("uses the missing-replication fallback for null metric summaries", () => {
    const empty = variant("empty", "Empty", 0, 0, 0, 0);
    empty.aggregate.successRate = null;
    empty.aggregate.services.checkout.admittedAmplification = null;

    render(<VariantComparisonChart variants={[empty]} />);

    const figure = screen.getByRole("figure", { name: "Variant comparison" });
    expect(figure.textContent).toContain("Empty: not enough replications");
    expect(figure.textContent).toContain("Success N/A (not enough replications)");
    expect(figure.textContent).toContain(
      "checkout admitted amplification N/A (not enough replications)",
    );
    expect(figure.textContent).not.toContain("95% CI unavailable");
  });
});

describe("SweepControls", () => {
  it("accepts an arrival-rate list in order without a target", () => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/^Sweep values/), {
      target: { value: "25, 50.5, 100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));

    expect(onChange).toHaveBeenCalledWith({
      parameter: "ARRIVAL_RATE",
      serviceId: null,
      linkId: null,
      values: [0.025, 0.0505, 0.1],
    });
  });

  it.each(["1e-307", "1e-323"])("rejects RPS %s with a non-finite converted interarrival mean", (value) => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Sweep values (RPS)"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("requires a link target and preserves the ordered values", () => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Sweep parameter"), {
      target: { value: "LINK_TIMEOUT" },
    });
    fireEvent.change(screen.getByLabelText(/^Sweep values/), {
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
    fireEvent.change(screen.getByLabelText(/^Sweep values/), {
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
    const values = screen.getByLabelText(/^Sweep values/);

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

  it.each([
    ["ARRIVAL_RATE", "0", null],
    ["ARRIVAL_RATE", "-1", null],
    ["LINK_TIMEOUT", "0", "link"],
    ["LINK_TIMEOUT", "-1", "link"],
    ["BACKOFF_BASE", "-0.01", "link"],
    ["DEGRADATION_MULTIPLIER", "0", "service"],
    ["DEGRADATION_MULTIPLIER", "-2", "service"],
    ["MAX_ATTEMPTS", "0", "link"],
    ["MAX_ATTEMPTS", "2147483648", "link"],
  ])("rejects out-of-range %s value %s", (parameter, value, targetKind) => {
    const onChange = vi.fn();
    render(<SweepControls onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Sweep parameter"), { target: { value: parameter } });
    if (targetKind !== null) {
      fireEvent.change(screen.getByLabelText(targetKind === "link" ? "Link ID" : "Service ID"), {
        target: { value: "target-1" },
      });
    }
    fireEvent.change(screen.getByLabelText(/^Sweep values/), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/greater than zero|non-negative|1\.\.2147483647/);
  });
});

describe("SweepChart", () => {
  const sweepVariants = [0.025, 0.05, 0.1].map((value, index) => ({
    ...variant(`variant-${[900, 100, 500][index]}`, `Point ${index}`, 0.9 - index * 0.1, 120 + index * 10, 240, 1.25 + index),
    sweepParameter: "ARRIVAL_RATE" as const,
    sweepValue: value,
  }));

  it("uses only sweep metadata for all three x values and supports metric selection", () => {
    render(<SweepChart variants={[sweepVariants[2], sweepVariants[0], sweepVariants[1]]} />);

    const figure = screen.getByRole("figure", { name: "Parameter sweep" });
    const points = within(figure).getAllByRole("listitem");
    expect(points.map((point) => point.textContent)).toEqual([
      "25 RPS: 90.00% (not enough replications)",
      "50 RPS: 80.00% (not enough replications)",
      "100 RPS: 70.00% (not enough replications)",
    ]);
    expect(figure.textContent).not.toContain("900");

    fireEvent.change(screen.getByLabelText("Sweep metric"), { target: { value: "p95" } });
    expect(points.map((point) => point.textContent)).toEqual([
      "25 RPS: 120.00 ms (not enough replications)",
      "50 RPS: 130.00 ms (not enough replications)",
      "100 RPS: 140.00 ms (not enough replications)",
    ]);

    fireEvent.change(screen.getByLabelText("Sweep metric"), {
      target: { value: "amplification" },
    });
    expect(points.map((point) => point.textContent)).toEqual([
      "25 RPS: checkout 1.25× (not enough replications)",
      "50 RPS: checkout 2.25× (not enough replications)",
      "100 RPS: checkout 3.25× (not enough replications)",
    ]);
  });

  it("shows available confidence intervals for every selectable sweep metric", () => {
    const point = structuredClone(sweepVariants[0]);
    point.aggregate.successRate = metric(0.9, 0.81, 0.99);
    point.aggregate.p95LatencyMs = metric(120, 110, 130);
    point.aggregate.services.checkout.admittedAmplification = metric(1.25, 1, 1.5);
    render(<SweepChart variants={[point]} />);

    const figure = screen.getByRole("figure", { name: "Parameter sweep" });
    const value = () => within(figure).getByRole("listitem").textContent;
    expect(value()).toBe("25 RPS: 90.00% (95% CI [81.00%, 99.00%])");

    fireEvent.change(screen.getByLabelText("Sweep metric"), { target: { value: "p95" } });
    expect(value()).toBe("25 RPS: 120.00 ms (95% CI [110.00 ms, 130.00 ms])");

    fireEvent.change(screen.getByLabelText("Sweep metric"), {
      target: { value: "amplification" },
    });
    expect(value()).toBe("25 RPS: checkout 1.25× (95% CI [1.00×, 1.50×])");
  });

  it("separates mixed sweep parameters and labels the selected x-axis parameter", () => {
    const linkPoint = {
      ...structuredClone(sweepVariants[0]),
      id: "link-point",
      sweepParameter: "LINK_TIMEOUT" as const,
      sweepValue: 500,
    };
    render(<SweepChart variants={[sweepVariants[0], linkPoint, sweepVariants[1]]} />);

    const figure = screen.getByRole("figure", { name: "Parameter sweep" });
    const points = () => within(figure).getAllByRole("listitem").map((point) => point.textContent);
    expect(figure.textContent).toContain("Arrival rate (RPS)");
    expect(points()).toEqual([
      "25 RPS: 90.00% (not enough replications)",
      "50 RPS: 80.00% (not enough replications)",
    ]);

    fireEvent.change(screen.getByLabelText("Sweep chart parameter"), {
      target: { value: "LINK_TIMEOUT" },
    });
    expect(figure.textContent).toContain("LINK_TIMEOUT");
    expect(points()).toEqual(["500: 90.00% (not enough replications)"]);
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

  it("renders comparison and sweep sections independently for mixed results", () => {
    const sweepPoint = {
      ...structuredClone(candidate),
      id: "arrival-25",
      label: "Arrival 25",
      sweepParameter: "ARRIVAL_RATE" as const,
      sweepValue: 0.025,
    };
    render(
      <ResultPanel
        jobId="job-mixed"
        result={{ ...result, variants: [baseline, candidate, sweepPoint] }}
      />,
    );

    const comparison = screen.getByRole("figure", { name: "Variant comparison" });
    const sweep = screen.getByRole("figure", { name: "Parameter sweep" });
    expect(comparison.textContent).toContain("Baseline");
    expect(comparison.textContent).toContain("Candidate");
    expect(comparison.textContent).not.toContain("Arrival 25");
    expect(within(sweep).getByRole("listitem").textContent).toBe(
      "25 RPS: 75.00% (not enough replications)",
    );
  });
});
