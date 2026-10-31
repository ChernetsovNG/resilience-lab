import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { slotPoolResource, noSaturation } from "../test/fixtures";
import { SaturationInsight } from "./SaturationInsight";

describe("SaturationInsight", () => {
  it("renders the conclusion, all rule parameters and expandable paths", () => {
    const saturation = {
      ...noSaturation,
      rule: { ...noSaturation.rule, futureDurationMs: 125 },
      withoutSaturation: 1,
      firstNodes: [{ node: "dependency", ...slotPoolResource("dependency"), replicationCount: 1, medianStartMs: 80, minStartMs: 80, maxStartMs: 80 }],
      replications: [
        { replication: 0, degradationPath: [{ node: "dependency", ...slotPoolResource("dependency"), startMs: 80 }, { node: "middle", ...slotPoolResource("middle"), startMs: 100 }] },
        { replication: 1, degradationPath: [] },
      ],
    };
    render(<SaturationInsight saturation={saturation} replications={2} />);
    expect(screen.getByText("handlers dependency first in 1 of 2 replications; median start 80 ms, range 80 ms–80 ms.")).toBeTruthy();
    expect(screen.getByText("1 of 2 replications without saturation.")).toBeTruthy();
    expect(screen.getByText(/futureDurationMs = 125/)).toBeTruthy();
    const rule = screen.getByText("How saturation is detected").closest("details")!;
    expect(rule.open).toBe(false);
    fireEvent.click(screen.getByText("How saturation is detected"));
    expect(rule.open).toBe(true);
    expect(rule.textContent).toContain("at or above 95%");
    expect(rule.textContent).toContain("mean queue stays above 0.5 for at least 100 ms");
    expect(rule.textContent).toContain("more than 0 rejections (queue full or wait limit)");
    const details = screen.getByText("Degradation paths").closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText("Degradation paths"));
    expect(details.open).toBe(true);
    expect(screen.getByText("handlers dependency at 80 ms → handlers middle at 100 ms — 1 of 2 replications")).toBeTruthy();
    expect(screen.getByText("no saturation — 1 of 2 replications")).toBeTruthy();
  });

  it("replaces the previous conclusion and paths when another point has no saturation", () => {
    const { rerender } = render(<SaturationInsight saturation={{
      ...noSaturation,
      firstNodes: [{ node: "dependency", ...slotPoolResource("dependency"), replicationCount: 1, medianStartMs: 80, minStartMs: 80, maxStartMs: 80 }],
      replications: [{ replication: 0, degradationPath: [{ node: "dependency", ...slotPoolResource("dependency"), startMs: 80 }] }],
      withoutSaturation: 0,
    }} replications={1} />);
    rerender(<SaturationInsight saturation={noSaturation} replications={2} />);
    expect(screen.getByText("No saturation.")).toBeTruthy();
    expect(screen.getByText("2 of 2 replications without saturation.")).toBeTruthy();
    expect(screen.queryByText(/dependency/)).toBeNull();
  });
});
