import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { catalog, model, slotPoolResource, noSaturation, summary } from "../test/fixtures";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";
import { setLanguage } from "../i18n";
import { setConfidenceLevel } from "./confidenceLevel";

const comparison = () => screen.getByRole("table", { name: "Findings" });
const cells = (name: string, table = comparison()) => within(within(table).getByRole("row", { name: new RegExp(name) })).getAllByRole("cell");
afterEach(() => { act(() => { setConfidenceLevel(95); setLanguage("en"); }); localStorage.clear(); });

describe("SummaryTable", () => {
  it.each(["en", "ru"] as const)("resolves stored variant fallbacks and parameter paths in the %s Findings", locale => {
    setLanguage(locale);
    const run = structuredClone(summary);
    run.variants[1].id = "variant-2";
    run.variants[1].label = "variant-2";
    run.grid = [{ path: "gateway.handlers", values: [4] }];
    run.variants[1].points[0].coordinates = { "gateway.handlers": 4 };
    render(<SummaryTable summary={run} catalog={catalog} model={model} activeVariantId="variant-2" />);
    const heading = within(screen.getByRole("region", { name: locale === "en" ? "Saturation insight" : "Вывод о насыщении" })).getByRole("heading");
    expect(heading.textContent).toBe(locale === "en" ? "Variant 2 · Handlers · gateway = 4" : "Вариант 2 · Обработчики · gateway = 4");
    expect(screen.getByRole("table", { name: locale === "en" ? "Findings" : "Выводы" }).textContent).not.toMatch(/variant-2|p0|gateway\.handlers/);
  });

  it("summarizes both variants without switching the active page", () => {
    const run = structuredClone(summary);
    run.variants[1].points[0].aggregate.successRate = { count: 2, mean: 0.5, min: 0.5, max: 0.5 };
    run.variants[1].points[0].saturation = { ...noSaturation, withoutSaturation: 0,
      firstNodes: [{ node: "dependency", ...slotPoolResource("dependency"), replicationCount: 2, medianStartMs: 80, minStartMs: 70, maxStartMs: 90 }] };
    render(<SummaryTable summary={run} activeVariantId="baseline" />);
    const overview = screen.getByRole("region", { name: "Variant summary" });
    expect(overview.textContent).toContain("Baseline: no saturation. Success rate: 97.5%.");
    expect(overview.textContent).toContain("No retries: first saturation at handlers dependency. Success rate: 50%.");
    expect(overview.compareDocumentPosition(comparison()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("explains pooled and replication-mean p99 values in Russian", () => {
    setLanguage("ru");
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.pooledLatency.all = {
      meanMs: 22, p95Ms: 30, p99Ms: 54.1, statistics: { count: 2, sumMs: 44, sketch: [2] },
    };
    run.variants[0].points[0].aggregate.p99LatencyMs!.mean = 55.4;
    render(<SummaryTable summary={run} />);
    const insight = screen.getByRole("region", { name: "Вывод о насыщении" });
    expect(insight.textContent?.match(/по объединённым данным/g)).toHaveLength(1);
    expect(insight.textContent).toContain("54,1 мс");
    const table = screen.getByRole("table", { name: "Выводы" });
    expect(table.textContent).toContain("55,4 мс");
    expect(within(table).getByRole("caption").textContent).toContain("p95 и p99 — средние квантилей отдельных повторений");
    expect(insight.textContent).not.toContain("Запросов:");
  });
  it.each([
    { language: "en" as const, label: "Intervals", explanation: "No new run is needed: only the display changes." },
    { language: "ru" as const, label: "Интервалы", explanation: "Новый прогон не нужен: меняется только показ." },
  ])("explains the interval selector in $language and restores its shared value", ({ language, label, explanation }) => {
    act(() => { setLanguage(language); setConfidenceLevel(90); });
    const { unmount } = render(<SummaryTable summary={summary} />);
    const choice = screen.getByRole<HTMLSelectElement>("combobox", { name: label });
    expect(screen.getByRole("heading", { name: "Baseline" }).closest("header")?.contains(choice)).toBe(true);
    expect(choice.value).toBe("90");
    expect([...choice.options].map(option => option.value)).toEqual(["80", "90", "95", "99"]);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
    const help = screen.getByRole("tooltip");
    expect(help.textContent).toContain(explanation);
    expect(choice.getAttribute("aria-describedby")).toBe(help.id);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.change(choice, { target: { value: "99" } });
    unmount();
    render(<SummaryTable summary={summary} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: label }).value).toBe("99");
  });

  it("updates interval separation from Findings using each metric's observation count", () => {
    const run = structuredClone(summary);
    run.variants[0].replications = 5;
    run.variants[1].replications = 10;
    run.variants[0].points[0].aggregate.successRate = { count: 5, mean: 0.4, stdDev: 0.1, min: 0.3, max: 0.5 };
    run.variants[1].points[0].aggregate.successRate = { count: 10, mean: 0.55, stdDev: 0.1, min: 0.4, max: 0.7 };
    const original = structuredClone(run);
    render(<SummaryTable summary={run} />);
    const choice = screen.getByRole("combobox", { name: "Intervals" });
    expect((choice as HTMLSelectElement).value).toBe("95");
    expect(cells("Success rate")[0].textContent).toContain("95% CI 27.6%–52.4%");
    expect(cells("Success rate")[1].textContent).not.toContain("Intervals do not overlap");
    fireEvent.change(choice, { target: { value: "80" } });
    expect(cells("Success rate")[0].textContent).toContain("80% CI 33.1%–46.9%");
    expect(cells("Success rate")[1].textContent).toContain("Intervals do not overlap");
    fireEvent.change(choice, { target: { value: "99" } });
    expect(localStorage.getItem("resilience-lab.confidenceLevel")).toBe("99");
    expect(cells("Success rate")[1].textContent).toContain("99% CI");
    expect(cells("Success rate")[1].textContent).not.toContain("Intervals do not overlap");
    expect(run).toEqual(original);
  });

  it("uses the metric count for interval width and reliability even in a larger variant", () => {
    const run = structuredClone(summary);
    run.variants = [run.variants[0]];
    run.variants[0].replications = 20;
    run.variants[0].points[0].aggregate.successRate = { count: 2, mean: 0.375, stdDev: 0.1767766952966369,
      min: 0.25, max: 0.5, ci95Low: -1.213275592021838, ci95High: 1.963275592021838 };
    render(<SummaryTable summary={run} />);
    const interval = cells("Success rate")[0].querySelector(".summary-interval")!;
    expect(interval.textContent).toContain("95% CI -121.3%–196.3%");
    expect(interval.classList.contains("summary-interval--unreliable")).toBe(true);
    expect(screen.getByText("Unreliable interval: increase Replications.")).toBeTruthy();
  });

  it("orders baseline first without mutating the document and compares means in matching units", () => {
    const run = structuredClone(summary);
    run.variants[1].points[0].aggregate = { groups: [],
      pooledLatency: {}, services: {}, connections: {}, poolers: {}, successRate: { count: 2, mean: 0.995, min: 0.99, max: 1 },
      p95LatencyMs: { count: 2, mean: 31.25, min: 30, max: 32.5 }, p99LatencyMs: { count: 2, mean: 90, min: 89, max: 91 },
    };
    run.variants.reverse();
    render(<SummaryTable summary={run} activeVariantId="baseline" />);
    const headers = within(comparison()).getAllByRole("columnheader");
    expect(headers[1].textContent).toContain("Baseline");
    expect(headers[2].textContent).toContain("No retries");
    expect(headers[1].className).toContain("summary-column--active-variant");
    expect(cells("Success rate")[0].textContent).toContain("97.5% (95% CI 88.5%–106.5%)");
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
    run.variants[1].points[0].aggregate.successRate = { count: 2, mean: 0.975, min: 0.97, max: 0.98 };
    render(<SummaryTable summary={run} />);
    expect(within(comparison()).getAllByRole("columnheader")[1].textContent).toContain("Control");
    expect(within(comparison()).getByRole("caption").textContent).toContain("Differences from Control");
    expect(cells("Success rate")[1].querySelector(".summary-difference")?.textContent).toBe("0 pp");
  });

  it.each([
    [0.15, 0.005, 0.35, 0.005, true], [0.35, 0.005, 0.15, 0.005, true],
    [0.2, 0.05, 0.3, 0.05, false], [0.3, 0, 0.3, 0, false],
    [0.5, 0.2, 0.35, 0.005, false], [0.15, null, 0.35, 0.005, false], [0.15, 0.005, 0.35, null, false],
  ])("marks separation only for disjoint complete intervals (means/spreads: %s, %s; %s, %s)", (mean, stdDev, otherMean, otherStdDev, separate) => {
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.successRate = { count: 2, mean, stdDev, min: 0.1, max: 0.2 };
    run.variants[1].points[0].aggregate.successRate = { count: 2, mean: otherMean, stdDev: otherStdDev, min: 0.3, max: 0.4 };
    render(<SummaryTable summary={run} />);
    expect(within(cells("Success rate")[1]).queryByText("Intervals do not overlap") !== null).toBe(separate);
    expect(within(cells("Success rate")[0]).queryByText("Intervals do not overlap")).toBeNull();
  });

  it.each([1, 2, 4, 5, 10])("retains unclipped intervals and warns only below five observations (n=%s)", replications => {
    const run = structuredClone(summary);
    run.variants = [run.variants[0]];
    run.variants[0].replications = 20;
    const aggregate = run.variants[0].points[0].aggregate;
    aggregate.p95LatencyMs!.count = replications;
    aggregate.p99LatencyMs!.count = replications;
    aggregate.services.gateway.admittedAmplification!.count = replications;
    run.variants[0].points[0].aggregate.successRate = { count: replications, mean: 0.5, stdDev: 2, min: 0, max: 1, ci95Low: -0.2, ci95High: 1.2 };
    render(<SummaryTable summary={run} />);
    expect(screen.queryByText("Unreliable interval: increase Replications.") !== null).toBe(replications < 5);
    const interval = cells("Success rate")[0].querySelector(".summary-interval");
    if (replications < 2) expect(interval).toBeNull();
    else {
      expect(interval!.textContent).toMatch(/95% CI -/);
      expect(interval!.classList.contains("summary-interval--unreliable")).toBe(replications < 5);
    }
  });

  it("compares service amplification and pooled utilization without inventing pooled confidence intervals", () => {
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.services.gateway.admittedAmplification = {
      count: 2, mean: 1.2, stdDev: 0.02, min: 1.1, max: 1.3, ci95Low: 1, ci95High: 1.4,
    };
    const alternative = structuredClone(run.variants[0].points[0].aggregate.services.gateway);
    alternative.admittedAmplification = { count: 2, mean: 1.7, stdDev: 0.01, min: 1.6, max: 1.8, ci95Low: 1.6, ci95High: 1.8 };
    alternative.totals.slotPools.handlers.busyIntegralMs = 1500;
    run.variants[1].points[0].aggregate.services.gateway = alternative;
    render(<SummaryTable summary={run} />);
    fireEvent.click(screen.getByText("gateway metrics"));
    const table = screen.getByRole("table", { name: "Element metrics: gateway" });
    expect(cells("Attempts per request", table)[0].textContent).toContain("95% CI 1.02×–1.38×");
    expect(cells("Attempts per request", table)[1].textContent).toContain("+0.5×");
    expect(cells("Attempts per request", table)[1].textContent).toContain("Intervals do not overlap");
    const utilization = cells("Resource utilization", table);
    expect(utilization[0].textContent).toBe("50%");
    expect(utilization[1].textContent).toContain("75%");
    expect(utilization[1].textContent).toContain("+25 pp");
    expect(utilization[1].textContent).not.toContain("95% CI");
    expect(utilization[1].textContent).not.toContain("Intervals do not overlap");
  });

  it("handles missing metrics and zero capacity without fabricated differences", () => {
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.services.gateway.totals.slotPools.handlers.capacityIntegralMs = 0;
    render(<SummaryTable summary={run} />);
    expect(cells("Success rate")[1].textContent).toBe("n/a");
    fireEvent.click(screen.getByText("gateway metrics"));
    const table = screen.getByRole("table", { name: "Element metrics: gateway" });
    expect(cells("Resource utilization", table).map(cell => cell.textContent)).toEqual(["n/a", "n/a"]);
  });

  it("leads with all saturation details for the active variant and selected point", () => {
    const run = structuredClone(summary);
    run.variants[1].points.push({ ...run.variants[1].points[0], id: "p1", saturation: {
      ...noSaturation, withoutSaturation: 1,
      firstNodes: [{ node: "dependency", ...slotPoolResource("dependency"), replicationCount: 1, medianStartMs: 80, minStartMs: 70, maxStartMs: 90 }],
      replications: [{ replication: 0, degradationPath: [{ node: "dependency", ...slotPoolResource("dependency"), startMs: 80 }] }, { replication: 1, degradationPath: [] }],
    } });
    render(<SummaryTable summary={run} activeVariantId="no-retries" selectedPointId="p1" />);
    const insight = screen.getByRole("region", { name: "Saturation insight" });
    expect(within(insight).getByRole("heading").textContent).toContain("No retries");
    expect(insight.textContent).toContain("handlers dependency first in 1 of 2 replications; median start 80 ms, range 70 ms–90 ms.");
    expect(insight.textContent).toContain("1 of 2 replications without saturation.");
    expect(insight.textContent).toContain("How saturation is detected");
    fireEvent.click(within(insight).getByText("Degradation paths"));
    expect(within(insight).getByText("handlers dependency at 80 ms — 1 of 2 replications")).toBeTruthy();
    expect(insight.compareDocumentPosition(comparison()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows only the variant label in the heading without a grid", () => {
    render(<SummaryTable summary={summary} activeVariantId="baseline" />);
    expect(within(screen.getByRole("region", { name: "Saturation insight" })).getByRole("heading").textContent).toBe("Baseline");
  });

  it("shows coordinates instead of point IDs in the heading with a grid", () => {
    const run = structuredClone(summary);
    run.grid = [{ path: "gateway.handlers", values: [4, 6] }, { path: "dependency.processing.mean", values: ["8ms", "12ms"] }];
    run.variants[0].points.push({ ...run.variants[0].points[0], id: "p3",
      coordinates: { "gateway.handlers": 6, "dependency.processing.mean": "12ms" } });
    render(<SummaryTable summary={run} activeVariantId="baseline" selectedPointId="p3" />);
    expect(within(screen.getByRole("region", { name: "Saturation insight" })).getByRole("heading").textContent)
      .toBe("Baseline · Handlers · gateway = 6, Processing time · Mean · dependency = 12ms");
  });

  it("shows recorded capacity headroom and pooled entry p99", () => {
    const run = structuredClone(summary);
    const point = run.variants[0].points[0];
    point.aggregate.services.middle = structuredClone(point.aggregate.services.gateway);
    Object.assign(point.aggregate.services.middle.totals, { measurementMs: 1000,
      slotPools: { handlers: { busyIntegralMs: 1800, queueIntegralMs: 750, capacityIntegralMs: 6000, waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } });
    point.aggregate.services.dependency = structuredClone(point.aggregate.services.gateway);
    Object.assign(point.aggregate.services.dependency.totals, { measurementMs: 2000,
      slotPools: { handlers: { busyIntegralMs: 900, queueIntegralMs: 160, capacityIntegralMs: 1000, waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } });
    point.headroom = {
      utilization: { node: "dependency", slotPool: "handlers", value: 0.9, label: slotPoolResource("dependency").label },
      meanQueueLength: { node: "middle", slotPool: "handlers", value: 0.75, label: slotPoolResource("middle").label },
    };
    point.aggregate.pooledLatency.all = { meanMs: 22, p95Ms: 30, p99Ms: 123.4,
      statistics: { count: 24, sumMs: 528, sketch: [24] } };
    const view = render(<SummaryTable summary={run} activeVariantId="baseline" />);
    const headroom = screen.getByText(/^Capacity headroom/);
    expect(headroom.textContent).toBe("Capacity headroom (pooled): highest utilization 90% (handlers dependency); largest mean number of queued requests 0.75 (handlers middle); entry p99 123.4 ms.");
    expect(headroom.textContent).not.toContain("80 ms");
    view.rerender(<SummaryTable summary={run} activeVariantId="no-retries" />);
    expect(screen.getByText(/^Capacity headroom/).textContent).toBe("Capacity headroom (pooled): highest utilization n/a (n/a); largest mean number of queued requests n/a (n/a); entry p99 n/a.");
  });

  it.each([[2, 1], [0, 0]])("hides headroom when any replication saturated or none ran (%s, %s)", (replications, withoutSaturation) => {
    const run = structuredClone(summary);
    run.variants[0].replications = replications;
    run.variants[0].points[0].saturation.withoutSaturation = withoutSaturation;
    render(<SummaryTable summary={run} activeVariantId="baseline" />);
    expect(screen.queryByText(/^Capacity headroom/)).toBeNull();
  });

  it("does not infer headroom from zero denominators or replication-mean p99", () => {
    const run = structuredClone(summary);
    Object.assign(run.variants[0].points[0].aggregate.services.gateway.totals, { measurementMs: 0,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: 0, waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } });
    render(<SummaryTable summary={run} activeVariantId="baseline" />);
    expect(screen.getByText(/^Capacity headroom/).textContent).toBe("Capacity headroom (pooled): highest utilization n/a (n/a); largest mean number of queued requests n/a (n/a); entry p99 n/a.");
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
    expect(screen.getByText("No results for Baseline at Handlers · gateway = 6.")).toBeTruthy();
    expect(screen.getByText("Baseline has no results at Handlers · gateway = 6; differences are unavailable.")).toBeTruthy();
    expect(within(comparison()).getAllByRole("columnheader")).toHaveLength(2);
    expect(cells("Success rate")[0].textContent).toContain("50%");
    expect(comparison().querySelector(".summary-difference")).toBeNull();
    expect(comparison().textContent).not.toContain("97.5%");
  });
});

describe("ProblemList", () => {
  it("leads with the explanation and keeps its code and location on a secondary line", () => {
    render(<ProblemList problem={{ code: "INVALID", message: "Invalid experiment", diagnostics: [
      { code: "CAPACITY", severity: "ERROR", message: "Increase the connection limit", document: "model.json", pointer: "/blocks/db/params/handlers" },
    ] }} />);
    const row = screen.getByRole("listitem");
    expect(row.firstElementChild?.textContent).toBe("Increase the connection limit");
    expect(row.querySelector(".diagnostic-details")?.textContent).toContain("CAPACITY");
  });
  it("lists diagnostics with their location", () => {
    render(<ProblemList problem={{
      code: "EXPERIMENT_INVALID", message: "Experiment has errors",
      diagnostics: [{ code: "PARAM_MISSING", severity: "ERROR", message: "Required parameter 'handlers' is missing",
        document: "m.model.json", pointer: "/blocks/gateway/params/handlers" }],
    }} />);
    expect(screen.getByRole("listitem").querySelector(".diagnostic-message")?.textContent).toBe("Required parameter 'handlers' is missing");
    expect(screen.getByRole("listitem").querySelector(".diagnostic-details")?.textContent)
      .toBe("PARAM_MISSING · m.model.json#/blocks/gateway/params/handlers");
  });

  it("uses experiment for diagnostics without a document or pointer", () => {
    render(<ProblemList problem={{ code: "INVALID", message: "Invalid experiment",
      diagnostics: [{ code: "EMPTY", severity: "ERROR", message: "No variants" }],
    }} />);
    expect(screen.getByRole("alert").textContent).toContain("No variants");
    expect(screen.getByRole("listitem").querySelector(".diagnostic-details")?.textContent).toBe("EMPTY · experiment");
  });
});

it("shows group aggregates with instance comparison tables nested inside", () => {
  const run = structuredClone(summary);
  const aggregate = run.variants[0].points[0].aggregate;
  const base = aggregate.services.gateway;
  aggregate.groups = [{ id: "workers", kind: "NODE", instances: [1, 2, 3].map(replica => ({ id: `workers#${replica}`, replica })) }];
  aggregate.services.workers = base;
  for (const replica of [1, 2, 3]) aggregate.services[`workers#${replica}`] = base;
  render(<SummaryTable summary={run} activeVariantId="baseline" />);
  expect(screen.getByRole("table", { name: /workers$/ })).toBeTruthy();
  const group = screen.getByText("Group: workers").closest("details")!;
  expect(group.querySelectorAll(".summary-services")).toHaveLength(3);
  expect(screen.getByRole("table", { name: /workers#1$/ })).toBeTruthy();
});
