import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { summary } from "../test/fixtures";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

describe("SummaryTable", () => {
  it("shows one row per variant with confidence intervals and service amplification", () => {
    render(<SummaryTable summary={summary} />);
    const table = screen.getByRole("table", { name: "Summary" });
    const baseline = within(table).getByRole("row", { name: /Baseline/ });
    expect(baseline.textContent).toContain("97.5% (95% CI 95.0%–100.0%)");
    expect(baseline.textContent).toContain("41.3 ms");
    expect(baseline.textContent).toContain("1.20×");
    expect(within(table).getByRole("columnheader", { name: "gateway admitted ×" })).toBeTruthy();
    expect(within(table).getByRole("row", { name: /No retries/ }).textContent).toContain("n/a");
  });

  it("preserves Student confidence limits outside the physical success-rate range", () => {
    const wide = structuredClone(summary);
    wide.variants[0].points[0].aggregate.successRate = { mean: 0.5, min: 0, max: 1, ci95Low: -0.2, ci95High: 1.2 };
    render(<SummaryTable summary={wide} />);
    expect(screen.getByRole("row", { name: /Baseline/ }).textContent).toContain("50.0% (95% CI -20.0%–120.0%)");
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

it("shows every grid point with coordinates, units and its own metrics", () => {
  render(
    <SummaryTable summary={{
      schemaVersion: 4,
      grid: [
        { path: "call.timeout", values: ["40ms", "80ms"] },
        { path: "service.handlers", values: [1] },
      ],
      experiment: "grid.experiment.json",
      variants: [{
        id: "baseline", label: "Baseline", replications: 2,
        points: [
          { id: "p0", coordinates: { "call.timeout": "40ms", "service.handlers": 1 },
            aggregate: { pooledLatency: {}, services: {}, successRate: { mean: 0.5, min: 0.4, max: 0.6 } } },
          { id: "p1", coordinates: { "call.timeout": "80ms", "service.handlers": 1 },
            aggregate: { pooledLatency: {}, services: {}, successRate: { mean: 1, min: 1, max: 1 } } },
        ],
      }],
    }} />,
  );

  const rows = screen.getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(within(rows[1]).getByText("p0")).toBeDefined();
  expect(within(rows[1]).getByText(/call.timeout.*40ms/)).toBeDefined();
  expect(within(rows[1]).getByText(/service.handlers.*1/)).toBeDefined();
  expect(within(rows[1]).getByText("50.0%")).toBeDefined();
  expect(within(rows[2]).getByText("p1")).toBeDefined();
  expect(within(rows[2]).getByText(/call.timeout.*80ms/)).toBeDefined();
  expect(within(rows[2]).getByText("100.0%")).toBeDefined();
});
