import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { noSaturation, summary } from "../test/fixtures";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

const comparison = () => screen.getByRole("table", { name: "Answer" });
const cells = (name: string, table = comparison()) => within(within(table).getByRole("row", { name: new RegExp(name) })).getAllByRole("cell");

describe("SummaryTable", () => {
  it("orders baseline first without mutating the document and compares means in matching units", () => {
    const run = structuredClone(summary);
    run.variants[1].points[0].aggregate = {
      pooledLatency: {}, services: {}, connections: {}, successRate: { mean: 0.995, min: 0.99, max: 1 },
      p95LatencyMs: { mean: 31.25, min: 30, max: 32.5 }, p99LatencyMs: { mean: 90, min: 89, max: 91 },
    };
    run.variants.reverse();
    render(<SummaryTable summary={run} activeVariantId="baseline" />);
    const headers = within(comparison()).getAllByRole("columnheader");
    expect(headers[1].textContent).toContain("Baseline");
    expect(headers[2].textContent).toContain("No retries");
    expect(headers[1].className).toContain("summary-column--active-variant");
    expect(cells("Success rate")[0].textContent).toContain("97.5% (95% CI 95%–100%)");
    expect(cells("Success rate")[1].textContent).toContain("+2 pp");
    expect(cells("p95 latency")[1].textContent).toContain("-10 ms");
    expect(cells("p99 latency")[1].textContent).toContain("+10 ms");
    expect(cells("Success rate")[0].querySelector(".summary-difference")).toBeNull();
    expect(run.variants.map(variant => variant.id)).toEqual(["no-retries", "baseline"]);
  });

  it("uses the first document variant as reference without a baseline ID", () => {
    const run = structuredClone(summary);
    run.variants[0].id = "control";
    run.variants[0].label = "Control";
    run.variants[1].points[0].aggregate.successRate = { mean: 0.975, min: 0.97, max: 0.98 };
    render(<SummaryTable summary={run} />);
    expect(within(comparison()).getAllByRole("columnheader")[1].textContent).toContain("Control");
    expect(within(comparison()).getByRole("caption").textContent).toContain("Differences from Control");
    expect(cells("Success rate")[1].querySelector(".summary-difference")?.textContent).toBe("0 pp");
  });

  it.each([
    [0.1, 0.2, 0.3, 0.4, true], [0.3, 0.4, 0.1, 0.2, true],
    [0.1, 0.3, 0.2, 0.4, false], [0.1, 0.3, 0.3, 0.4, false],
    [-0.2, 1.2, 0.3, 0.4, false], [null, null, 0.3, 0.4, false], [0.1, 0.2, null, null, false],
  ])("marks separation only for disjoint complete intervals (%s, %s; %s, %s)", (low, high, otherLow, otherHigh, separate) => {
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.successRate = { mean: 0.15, min: 0.1, max: 0.2, ci95Low: low, ci95High: high };
    run.variants[1].points[0].aggregate.successRate = { mean: 0.35, min: 0.3, max: 0.4, ci95Low: otherLow, ci95High: otherHigh };
    render(<SummaryTable summary={run} />);
    expect(within(cells("Success rate")[1]).queryByText("Intervals do not overlap") !== null).toBe(separate);
    expect(within(cells("Success rate")[0]).queryByText("Intervals do not overlap")).toBeNull();
  });

  it.each([1, 2, 4, 5, 10])("retains unclipped intervals and warns only below five replications (n=%s)", replications => {
    const run = structuredClone(summary);
    run.variants = [run.variants[0]];
    run.variants[0].replications = replications;
    run.variants[0].points[0].aggregate.successRate = { mean: 0.5, min: 0, max: 1, ci95Low: -0.2, ci95High: 1.2 };
    render(<SummaryTable summary={run} />);
    expect(screen.queryByText("Unreliable interval: increase Replications.") !== null).toBe(replications < 5);
    const interval = cells("Success rate")[0].querySelector(".summary-interval")!;
    expect(interval.textContent).toContain("95% CI -20%–120%");
    expect(interval.classList.contains("summary-interval--unreliable")).toBe(replications < 5);
  });

  it("compares service amplification and pooled utilization without inventing pooled confidence intervals", () => {
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.services.gateway.admittedAmplification = {
      mean: 1.2, min: 1.1, max: 1.3, ci95Low: 1, ci95High: 1.4,
    };
    const alternative = structuredClone(run.variants[0].points[0].aggregate.services.gateway);
    alternative.admittedAmplification = { mean: 1.7, min: 1.6, max: 1.8, ci95Low: 1.6, ci95High: 1.8 };
    alternative.totals.busyHandlerTimeMs = 1500;
    run.variants[1].points[0].aggregate.services.gateway = alternative;
    render(<SummaryTable summary={run} />);
    fireEvent.click(screen.getByText("gateway metrics"));
    const table = screen.getByRole("table", { name: "Service metrics: gateway" });
    expect(cells("Admitted amplification", table)[0].textContent).toContain("95% CI 1×–1.4×");
    expect(cells("Admitted amplification", table)[1].textContent).toContain("+0.5×");
    expect(cells("Admitted amplification", table)[1].textContent).toContain("Intervals do not overlap");
    const utilization = cells("Handler utilization", table);
    expect(utilization[0].textContent).toBe("50%");
    expect(utilization[1].textContent).toContain("75%");
    expect(utilization[1].textContent).toContain("+25 pp");
    expect(utilization[1].textContent).not.toContain("95% CI");
    expect(utilization[1].textContent).not.toContain("Intervals do not overlap");
  });

  it("handles missing metrics and zero capacity without fabricated differences", () => {
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.services.gateway.totals.handlerCapacityTimeMs = 0;
    render(<SummaryTable summary={run} />);
    expect(cells("Success rate")[1].textContent).toBe("n/a");
    fireEvent.click(screen.getByText("gateway metrics"));
    const table = screen.getByRole("table", { name: "Service metrics: gateway" });
    expect(cells("Handler utilization", table).map(cell => cell.textContent)).toEqual(["n/a", "n/a"]);
  });

  it("leads with all saturation details for the active variant and selected point", () => {
    const run = structuredClone(summary);
    run.variants[1].points.push({ ...run.variants[1].points[0], id: "p1", saturation: {
      ...noSaturation, withoutSaturation: 1,
      firstNodes: [{ node: "dependency", replicationCount: 1, medianStartMs: 80, minStartMs: 70, maxStartMs: 90 }],
      replications: [{ replication: 0, degradationPath: [{ node: "dependency", startMs: 80 }] }, { replication: 1, degradationPath: [] }],
    } });
    render(<SummaryTable summary={run} activeVariantId="no-retries" selectedPointId="p1" />);
    const insight = screen.getByRole("region", { name: "Saturation insight" });
    expect(within(insight).getByRole("heading").textContent).toContain("No retries");
    expect(insight.textContent).toContain("dependency first in 1 of 2 replications; median start 80 ms, range 70–90 ms.");
    expect(insight.textContent).toContain("1 of 2 replications without saturation.");
    expect(insight.textContent).toContain("Saturation rule:");
    fireEvent.click(within(insight).getByText("Degradation paths"));
    expect(within(insight).getByText("Replication 0: dependency at 80 ms")).toBeTruthy();
    expect(insight.compareDocumentPosition(comparison()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses the first document variant for the model-page insight, regardless of baseline column order", () => {
    const run = structuredClone(summary);
    run.variants.reverse();
    render(<SummaryTable summary={run} />);
    expect(within(screen.getByRole("region", { name: "Saturation insight" })).getByRole("heading").textContent).toContain("No retries");
    expect(within(comparison()).getAllByRole("columnheader")[1].textContent).toContain("Baseline");
  });

  it("compares only the selected point without replacing a baseline missing that point", () => {
    const run = structuredClone(summary);
    run.grid = [{ path: "gateway.handlers", values: [4, 6] }];
    const point = structuredClone(run.variants[0].points[0]);
    point.id = "p1";
    point.aggregate.successRate!.mean = 0.5;
    run.variants[1].points.push(point);
    render(<SummaryTable summary={run} activeVariantId="baseline" selectedPointId="p1" />);
    expect(screen.getByText("No results for Baseline at p1.")).toBeTruthy();
    expect(screen.getByText("Baseline has no results at p1; differences are unavailable.")).toBeTruthy();
    expect(within(comparison()).getAllByRole("columnheader")).toHaveLength(2);
    expect(cells("Success rate")[0].textContent).toContain("50%");
    expect(comparison().querySelector(".summary-difference")).toBeNull();
    expect(comparison().textContent).not.toContain("97.5%");
  });
});

describe("ProblemList", () => {
  it("lists diagnostics with their location", () => {
    render(<ProblemList problem={{
      code: "EXPERIMENT_INVALID", message: "Experiment has errors",
      diagnostics: [{ code: "PARAM_MISSING", severity: "ERROR", message: "Required parameter 'handlers' is missing",
        document: "m.model.json", pointer: "/blocks/gateway/params/handlers" }],
    }} />);
    expect(screen.getByRole("alert").textContent).toContain(
      "PARAM_MISSING m.model.json#/blocks/gateway/params/handlers: Required parameter 'handlers' is missing",
    );
  });

  it("uses experiment for diagnostics without a document or pointer", () => {
    render(<ProblemList problem={{ code: "INVALID", message: "Invalid experiment",
      diagnostics: [{ code: "EMPTY", severity: "ERROR", message: "No variants" }],
    }} />);
    expect(screen.getByRole("alert").textContent).toContain("EMPTY experiment: No variants");
  });
});
