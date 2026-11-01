import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slotPoolResource, noSaturation } from "../test/fixtures";
import { SaturationInsight } from "./SaturationInsight";
import { setLanguage } from "../i18n";

afterEach(() => setLanguage("en"));

describe("SaturationInsight", () => {
  it("navigates to each recorded degradation step, including a connection pool", () => {
    const onElement = vi.fn();
    const pool = { node: "to-db", slotPool: "connections", label: { code: "RESULT_SLOT_POOL", message: "connection pool gateway → db", args: { from: "gateway", to: "db" } }, startMs: 120 };
    render(<SaturationInsight saturation={{ ...noSaturation, withoutSaturation: 0, replications: [
      { replication: 0, degradationPath: [pool, { node: "gateway", ...slotPoolResource("gateway"), startMs: 150 }] },
    ] }} replications={1} onElement={onElement} />);
    fireEvent.click(screen.getByText("Degradation paths"));
    fireEvent.click(screen.getByRole("button", { name: "connection pool gateway → db at 120 ms" }));
    expect(onElement).toHaveBeenLastCalledWith("to-db");
    fireEvent.click(screen.getByRole("button", { name: "handlers gateway at 150 ms" }));
    expect(onElement).toHaveBeenLastCalledWith("gateway");
  });

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

it("keeps the no-saturation conclusion as text when element navigation is available", () => {
  render(<SaturationInsight saturation={noSaturation} replications={2} onElement={vi.fn()} />);
  expect(screen.getByText("No saturation.").closest("button")).toBeNull();
});


it("shows the three most frequent paths and discloses the remaining paths", () => {
  const step = (node: string, startMs: number) => ({ node, ...slotPoolResource(node), startMs });
  const saturation = { ...noSaturation, replications: [
    { replication: 0, degradationPath: [step("rare-a", 10)] },
    ...[1, 2, 3, 4].map(replication => ({ replication, degradationPath: [step("frequent", 20 + replication)] })),
    ...["rare-b", "rare-c", "rare-d"].map((node, index) => ({ replication: 5 + index, degradationPath: [step(node, 30)] })),
  ] };
  render(<SaturationInsight saturation={saturation} replications={8} />);
  fireEvent.click(screen.getByText("Degradation paths"));
  const paths = screen.getByText("Degradation paths").closest("details")!;
  expect(paths.querySelector("li")?.textContent).toBe("handlers frequent at 21 ms–24 ms — 4 of 8 replications");
  const more = screen.getByText("2 more paths").closest("details")!;
  expect(more.open).toBe(false);
  expect(more.querySelectorAll("li")).toHaveLength(2);
  fireEvent.click(screen.getByText("2 more paths"));
  expect(more.open).toBe(true);
  expect(more.textContent).toContain("handlers rare-d");
});

it.each([
  { locale: "ru", count: 1, label: "Ещё 1 путь" },
  { locale: "ru", count: 2, label: "Ещё 2 пути" },
  { locale: "ru", count: 5, label: "Ещё 5 путей" },
  { locale: "ru", count: 11, label: "Ещё 11 путей" },
  { locale: "ru", count: 21, label: "Ещё 21 путь" },
  { locale: "ru", count: 22, label: "Ещё 22 пути" },
  { locale: "en", count: 1, label: "1 more path" },
  { locale: "en", count: 2, label: "2 more paths" },
  { locale: "en", count: 5, label: "5 more paths" },
] as const)("agrees path counts in $locale: $count", ({ locale, count, label }) => {
  setLanguage(locale);
  const replications = Array.from({ length: count + 3 }, (_, replication) => ({ replication,
    degradationPath: [{ node: `node-${replication}`, ...slotPoolResource(`node-${replication}`), startMs: 10 }],
  }));
  render(<SaturationInsight saturation={{ ...noSaturation, replications }} replications={replications.length} />);
  fireEvent.click(screen.getByText(locale === "en" ? "Degradation paths" : "Пути деградации"));
  expect(screen.getByText(label).closest("details")!.querySelectorAll("li")).toHaveLength(count);
});
