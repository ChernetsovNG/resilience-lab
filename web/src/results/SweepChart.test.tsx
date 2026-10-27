import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VariantResult } from "../api/types";
import { SweepChart } from "./SweepChart";

const captured = vi.hoisted(() => ({
  points: [] as Array<{ sweepValue: number }>,
  axes: [] as Array<{ ticks: number[]; label: { value: string } }>,
  lines: [] as Array<{ dataKey: unknown; name?: string }>,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
  LineChart: ({ children, data }: { children: ReactNode; data: Array<{ sweepValue: number }> }) => {
    captured.points = data;
    return children;
  },
  XAxis: (props: { ticks: number[]; label: { value: string } }) => {
    captured.axes.push(props);
    return null;
  },
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
  Line: (props: { dataKey: unknown; name?: string }) => {
    captured.lines.push(props);
    return null;
  },
}));

function sweepVariant(serviceId: string): VariantResult {
  return {
    id: "point-25",
    label: "Point 25",
    sweepParameter: "LINK_TIMEOUT",
    sweepValue: 25,
    replications: [],
    aggregate: {
      pooledLatency: { all: null, successful: null, failed: null },
      successRate: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
      services: {
        [serviceId]: {
          admittedAmplification: {
            mean: 2.75,
            stdDev: null,
            ci95Low: null,
            ci95High: null,
            min: 2.75,
            max: 2.75,
          },
          offeredAmplification: null,
        },
      },
    },
  };
}

describe("SweepChart service accessors", () => {
  beforeEach(() => {
    captured.lines.length = 0;
    captured.points.length = 0;
    captured.axes.length = 0;
  });

  it("plots arrival-rate metadata in RPS without changing the numerical result", () => {
    const variants = [0.025, 0.0505].map((sweepValue, index) => ({
      ...sweepVariant("checkout"),
      id: "arrival-" + index,
      sweepParameter: "ARRIVAL_RATE" as const,
      sweepValue,
    }));
    render(<SweepChart variants={variants} />);

    expect(captured.points.map((point) => point.sweepValue)).toEqual([25, 50.5]);
    expect(captured.axes[0].ticks).toEqual([25, 50.5]);
    expect(captured.axes[0].label.value).toBe("Arrival rate (RPS)");
    expect(variants.map((variant) => variant.sweepValue)).toEqual([0.025, 0.0505]);
  });

  it.each(["checkout.eu", "shard[1]", "checkout.eu[primary]"])(
    "reads amplification literally for service ID %s",
    (serviceId) => {
      render(<SweepChart variants={[sweepVariant(serviceId)]} />);
      fireEvent.change(screen.getByLabelText("Sweep metric"), {
        target: { value: "amplification" },
      });

      const line = captured.lines.find((candidate) => candidate.name === serviceId);
      expect(line).toBeDefined();
      expect(typeof line?.dataKey).toBe("function");
      const accessor = line?.dataKey as (
        point: { services: Record<string, number | null> },
      ) => number | null;
      expect(accessor({ services: { [serviceId]: 2.75 } })).toBe(2.75);
    },
  );
});
