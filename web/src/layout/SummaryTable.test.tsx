import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { catalog, model, slotPoolResource, noSaturation, summary } from "../test/fixtures";
import outputCatalog from "../test/catalog.json";
import { entryResults } from "../test/entryResults";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";
import { setLanguage } from "../i18n";
import { setConfidenceLevel } from "./confidenceLevel";

const comparison = () => screen.getByRole("table", { name: "Findings" });
const cells = (name: string, table = comparison()) => within(within(table).getByRole("row", { name: new RegExp(name) })).getAllByRole("cell");
afterEach(() => { act(() => { setConfidenceLevel(95); setLanguage("en"); }); localStorage.clear(); });

describe("SummaryTable", () => {
  it("uses the total entry for Findings when clients and classes have different results", () => {
    const run = structuredClone(summary);
    const aggregate = run.variants[0].points[0].aggregate;
    const metric = (mean: number) => ({ count: 2, mean, min: mean, max: mean });
    const total = { pooledLatency: {}, successRate: metric(0.75), p95LatencyMs: metric(40),
      p99LatencyMs: metric(80), failuresByReason: {}, degradedRate: metric(0) };
    run.variants[0].points[0].aggregate = { groups: [], services: aggregate.services,
      connections: {}, poolers: {}, entries: { total,
        clients: { "mobile-app": { ...total, successRate: metric(0.5) }, "partner-api": { ...total, successRate: metric(1) } },
        classes: { status: { ...total, successRate: metric(0.25) } },
      } };
    render(<SummaryTable summary={run} activeVariantId="baseline" />);
    expect(cells("Success rate")[0].textContent).toContain("75%");
    expect(cells("p95")[0].textContent).toContain("40 ms");
    expect(cells("p99")[0].textContent).toContain("80 ms");
    expect(screen.getByRole("region", { name: "Variant summary" }).textContent).toContain("Best observed success rate: Baseline (75%)");
  });
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
    run.variants[1].points[0].aggregate.entries.total.successRate = { count: 2, mean: 0.5, min: 0.5, max: 0.5 };
    run.variants[1].points[0].saturation = { ...noSaturation, withoutSaturation: 0,
      firstNodes: [{ node: "dependency", ...slotPoolResource("dependency"), replicationCount: 2, medianStartMs: 80, minStartMs: 70, maxStartMs: 90 }] };
    render(<SummaryTable summary={run} activeVariantId="baseline" />);
    const overview = screen.getByRole("region", { name: "Variant summary" });
    expect(overview.textContent).toContain("Baseline: no saturation.");
    expect(overview.textContent).toContain("No retries: first saturation at handlers dependency.");
    expect(overview.compareDocumentPosition(comparison()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("explains pooled and replication-mean p99 values in Russian", () => {
    setLanguage("ru");
    const run = structuredClone(summary);
    run.variants[0].points[0].aggregate.entries.total.pooledLatency.all = {
      meanMs: 22, p95Ms: 30, p99Ms: 54.1, statistics: { count: 2, sumMs: 44, sketch: [2] },
    };
    run.variants[0].points[0].aggregate.entries.total.p99LatencyMs!.mean = 55.4;
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
    run.variants[0].points[0].aggregate.entries.total.successRate = { count: 5, mean: 0.4, stdDev: 0.1, min: 0.3, max: 0.5 };
    run.variants[1].points[0].aggregate.entries.total.successRate = { count: 10, mean: 0.55, stdDev: 0.1, min: 0.4, max: 0.7 };
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
    run.variants[0].points[0].aggregate.entries.total.successRate = { count: 2, mean: 0.375, stdDev: 0.1767766952966369,
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
      services: {}, connections: {}, poolers: {}, entries: { total: {
        pooledLatency: {}, failuresByReason: {}, successRate: { count: 2, mean: 0.995, min: 0.99, max: 1 },
        p95LatencyMs: { count: 2, mean: 31.25, min: 30, max: 32.5 }, p99LatencyMs: { count: 2, mean: 90, min: 89, max: 91 },
      }, clients: {}, classes: {} },
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
    run.variants[1].points[0].aggregate.entries.total.successRate = { count: 2, mean: 0.975, min: 0.97, max: 0.98 };
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
    run.variants[0].points[0].aggregate.entries.total.successRate = { count: 2, mean, stdDev, min: 0.1, max: 0.2 };
    run.variants[1].points[0].aggregate.entries.total.successRate = { count: 2, mean: otherMean, stdDev: otherStdDev, min: 0.3, max: 0.4 };
    render(<SummaryTable summary={run} />);
    expect(within(cells("Success rate")[1]).queryByText("Intervals do not overlap") !== null).toBe(separate);
    expect(within(cells("Success rate")[0]).queryByText("Intervals do not overlap")).toBeNull();
  });

  it.each([1, 2, 4, 5, 10])("retains unclipped intervals and warns only below five observations (n=%s)", replications => {
    const run = structuredClone(summary);
    run.variants = [run.variants[0]];
    run.variants[0].replications = 20;
    const aggregate = run.variants[0].points[0].aggregate;
    aggregate.entries.total.p95LatencyMs!.count = replications;
    aggregate.entries.total.p99LatencyMs!.count = replications;
    aggregate.services.gateway.admittedAmplification!.count = replications;
    run.variants[0].points[0].aggregate.entries.total.successRate = { count: replications, mean: 0.5, stdDev: 2, min: 0, max: 1, ci95Low: -0.2, ci95High: 1.2 };
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
    point.aggregate.entries.total.pooledLatency.all = { meanMs: 22, p95Ms: 30, p99Ms: 123.4,
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
    point.aggregate.entries.total.successRate!.mean = 0.5;
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


describe("Findings conclusions", () => {
  const measured = (mean: number, stdDev = 0.01, count = 10) => ({ mean, stdDev, count, min: mean, max: mean });
  const compared = () => {
    const run = structuredClone(summary);
    const [base, other] = run.variants.map(variant => variant.points[0].aggregate.entries.total);
    base.successRate = measured(0.5);
    other.successRate = measured(0.9);
    base.p99LatencyMs = measured(100, 1);
    other.p99LatencyMs = measured(150, 1);
    return run;
  };

  it("names the higher success rate and lower p99 independently", () => {
    render(<SummaryTable summary={compared()} />);
    const conclusion = screen.getByTestId("comparison-conclusion");
    expect(conclusion.textContent).toContain("Best observed success rate: No retries (90%)");
    expect(conclusion.textContent).toContain("Lowest observed p99: Baseline (100 ms)");
    expect(conclusion.textContent).toContain("intervals do not overlap");
  });

  it("qualifies overlapping intervals and updates the conclusion with the confidence level", () => {
    const run = compared();
    run.variants[0].points[0].aggregate.entries.total.successRate = measured(0.4, 0.1, 5);
    run.variants[1].points[0].aggregate.entries.total.successRate = measured(0.55, 0.1);
    render(<SummaryTable summary={run} />);
    expect(screen.getByTestId("comparison-conclusion").textContent).toContain("No clear best success rate — the difference is within the spread (highest observed: No retries, 55%)");
    fireEvent.change(screen.getByRole("combobox", { name: "Intervals" }), { target: { value: "80" } });
    expect(screen.getByTestId("comparison-conclusion").textContent).not.toContain("difference within the spread");
    expect(screen.getByTestId("comparison-conclusion").textContent).toContain("intervals do not overlap");
  });

  it("names tied variants and distinguishes missing intervals from overlap", () => {
    const run = compared();
    run.variants[0].points[0].aggregate.entries.total.successRate = measured(0.9);
    run.variants[1].points[0].aggregate.entries.total.p99LatencyMs = { mean: 150, count: 1, min: 150, max: 150 };
    render(<SummaryTable summary={run} />);
    const conclusion = screen.getByTestId("comparison-conclusion");
    expect(conclusion.textContent).toContain("No clear best success rate — the difference is within the spread (highest observed: Baseline, No retries, 90%)");
    expect(conclusion.textContent).toContain("interval comparison unavailable: No retries");
  });

  it("does not declare a winner from missing metrics", () => {
    const run = compared();
    for (const variant of run.variants) variant.points[0].aggregate.entries.total.successRate = null;
    render(<SummaryTable summary={run} />);
    expect(screen.getByTestId("comparison-conclusion").textContent).toContain("Success rate: no data to compare");
  });

  it("names the selected grid point in both the overview and detailed insight", () => {
    const run = compared();
    run.grid = [{ path: "gateway.handlers", values: [4, 6] }];
    for (const variant of run.variants) variant.points.push({ ...structuredClone(variant.points[0]), id: "p1", coordinates: { "gateway.handlers": 6 } });
    render(<SummaryTable summary={run} catalog={catalog} model={model} selectedPointId="p1" />);
    for (const name of ["Variant summary", "Saturation insight"]) {
      expect(within(screen.getByRole("region", { name })).getByRole("heading").textContent).toContain("Handlers · gateway = 6");
    }
  });

  it("states a common first saturated resource once and keeps different resources separate", () => {
    const run = compared();
    const first = { node: "dependency", ...slotPoolResource("dependency"), replicationCount: 2, medianStartMs: 80, minStartMs: 70, maxStartMs: 90 };
    for (const variant of run.variants) variant.points[0].saturation = { ...noSaturation, firstNodes: [first], withoutSaturation: 0 };
    const { rerender } = render(<SummaryTable summary={run} />);
    const overview = screen.getByRole("region", { name: "Variant summary" });
    expect(overview.textContent).toContain("All variants: first saturation at handlers dependency.");
    expect(overview.textContent?.match(/first saturation at/g)).toHaveLength(1);
    const distinct = structuredClone(run);
    distinct.variants[1].points[0].saturation.firstNodes = [{ ...first, node: "gateway", ...slotPoolResource("gateway") }];
    rerender(<SummaryTable summary={distinct} />);
    expect(overview.textContent).toContain("Baseline: first saturation at handlers dependency.");
    expect(overview.textContent).toContain("No retries: first saturation at handlers gateway.");
  });

  it("marks quantized timeout ceilings using the effective variant and grid parameters", () => {
    setLanguage("ru");
    const run = compared();
    const source = structuredClone(model);
    source.blocks.client.params.deadline = "10s";
    source.connections.find(connection => connection.type === "call")!.params!.timeout = "5s";
    for (const variant of run.variants) {
      variant.points[0].aggregate.entries.total.p95LatencyMs = measured(5031.25, 0);
      variant.points[0].aggregate.entries.total.p99LatencyMs = measured(5031.25, 0);
    }
    const call = source.connections.find(connection => connection.type === "call")!;
    const variants = run.variants.map(variant => ({ id: variant.id, label: variant.label,
      overrides: variant.id === "baseline" ? {} : { [`${call.id}.timeout`]: "8s" } }));
    const { rerender } = render(<SummaryTable summary={run} model={source} catalog={catalog} variants={variants} />);
    const table = screen.getByRole("table", { name: "Выводы" });
    expect(cells("p99", table)[0].textContent).toContain("совпадает с таймаутом 5 с");
    expect(cells("p95", table)[0].textContent).toContain("совпадает с таймаутом 5 с");
    expect(cells("p99", table)[1].textContent).not.toContain("совпадает");
    run.grid = [{ path: `${call.id}.timeout`, values: ["5s"] }];
    for (const variant of run.variants) variant.points[0].coordinates = { [`${call.id}.timeout`]: "5s" };
    rerender(<SummaryTable summary={run} model={source} catalog={catalog} variants={variants} />);
    expect(cells("p99", table)[1].textContent).toContain("совпадает с таймаутом 5 с");
  });

  it("marks a client deadline but not a distant quantile or unavailable run documents", () => {
    const run = compared();
    run.variants[0].points[0].aggregate.entries.total.p95LatencyMs = measured(200, 0);
    run.variants[0].points[0].aggregate.entries.total.p99LatencyMs = measured(251, 0);
    const { rerender } = render(<SummaryTable summary={run} model={model} catalog={catalog} />);
    expect(cells("p99")[0].textContent).toContain("matches deadline 250 ms");
    expect(cells("p95")[0].textContent).not.toContain("matches");
    rerender(<SummaryTable summary={run} />);
    expect(cells("p99")[0].textContent).not.toContain("matches");
  });

  it.each([false, true])("compares every tied leader regardless of their ordering (reverse=%s)", reverse => {
    const run = compared();
    run.variants = [
      { label: "A", mean: 0.9, spread: 0.001 },
      { label: "B", mean: 0.9, spread: 0.2 },
      { label: "C", mean: 0.8, spread: 0.001 },
    ].map(({ label, mean, spread }) => {
      const variant = structuredClone(run.variants[0]);
      variant.id = label;
      variant.label = label;
      variant.points[0].aggregate.entries.total.successRate = measured(mean, spread);
      return variant;
    });
    if (reverse) run.variants.reverse();
    render(<SummaryTable summary={run} />);
    const conclusion = screen.getByTestId("comparison-conclusion");
    expect(conclusion.textContent).toContain("difference within the spread: C");
    expect(conclusion.textContent).not.toContain("intervals do not overlap with C");
  });

  it("describes numerical timeout matches without asserting they caused successful latency", () => {
    const run = compared();
    run.variants[0].points[0].aggregate.entries.total.successRate = measured(1, 0);
    run.variants[0].points[0].aggregate.entries.total.p99LatencyMs = measured(80, 0);
    render(<SummaryTable summary={run} model={model} catalog={catalog} />);
    expect(cells("p99")[0].textContent).toContain("matches timeout 80 ms");
    expect(cells("p99")[0].textContent).not.toContain("limited by");
  });

});


describe("entry populations", () => {
  it("keeps client and request-type groups collapsed and compares their own saved metrics", () => {
    const scenario = entryResults();
    render(<SummaryTable {...scenario} catalog={catalog} />);
    for (const title of ["By clients", "By request types"]) {
      const toggle = screen.getByText(title, { exact: true });
      expect(toggle.closest("details")!.open).toBe(false);
      fireEvent.click(toggle);
    }
    const client = screen.getByRole("table", { name: "Client · client" });
    expect(cells("Success rate", client)[0].textContent).toContain("80%");
    expect(cells("Success rate", client)[1].textContent).toContain("10 pp");
    expect(cells("p95", client)[0].textContent).toContain("95% CI");
    expect(cells("Success rate", screen.getByRole("table", { name: "Request type · checkout" }))[0].textContent).toContain("50%");
    expect(screen.getByTestId("comparison-conclusion").textContent).toContain("90%");
  });

  it("orders the top three reasons, expands all codes, and compares an absent reason as zero", () => {
    const scenario = entryResults();
    render(<SummaryTable {...scenario} catalog={catalog} />);
    const reasons = cells("Failure reasons")[0].querySelector("summary")!;
    expect(reasons.textContent).toBe("timeout 4% · breaker open 3% · processing error 3%");
    expect(reasons.textContent).not.toContain("queue full");
    fireEvent.click(reasons);
    expect(cells("Failure reasons")[0].textContent).toContain("queue full");
    expect(cells("Failure reasons")[0].querySelector('[title="timeout"]')).toBeTruthy();
    fireEvent.click(screen.getByText("By request types", { exact: true }));
    const status = screen.getByRole("table", { name: "Request type · status" });
    expect(cells("Failure reasons", status)[0].textContent).toContain("No failures");
    fireEvent.click(cells("Failure reasons", status)[0].querySelector("summary")!);
    expect(cells("Failure reasons", status)[0].textContent).toContain("timeout0%");
    fireEvent.click(cells("Failure reasons", status)[1].querySelector("summary")!);
    expect(cells("Failure reasons", status)[1].textContent).toContain("2 pp");
    expect(cells("Successful with fallback")[1].textContent).toContain("4.6%");
  });

  it("leaves old examples unchanged and shows zero fallback only when configured", () => {
    const { rerender } = render(<SummaryTable summary={summary} model={model} catalog={catalog} />);
    expect(screen.queryByText("By clients", { exact: true })).toBeNull();
    expect(screen.queryByText("By request types", { exact: true })).toBeNull();
    expect(screen.queryByRole("rowheader", { name: "Failure reasons" })).toBeNull();
    expect(screen.queryByRole("rowheader", { name: "Successful with fallback" })).toBeNull();
    const variants = summary.variants.map(variant => ({ ...variant, overrides: variant.id === "no-retries"
      ? { "gateway-to-middle.fallback": { on: ["timeout"], processing: "1ms" } } : {} }));
    rerender(<SummaryTable summary={summary} model={model} variants={variants} catalog={outputCatalog as typeof catalog} />);
    expect(cells("Successful with fallback")[0].textContent).toContain("0%");
  });
});


it("shows only groups with more than one population", () => {
  const scenario = entryResults();
  delete scenario.model.blocks.partner;
  scenario.model.blocks.client.params.classes = [{ id: "checkout", load: { points: [{ time: "0s", rate: "20/s" }] } }];
  for (const variant of scenario.summary.variants) {
    delete variant.points[0].aggregate.entries.clients.partner;
    delete variant.points[0].aggregate.entries.classes.status;
  }
  render(<SummaryTable {...scenario} catalog={catalog} />);
  expect(screen.queryByText("By clients", { exact: true })).toBeNull();
  expect(screen.queryByText("By request types", { exact: true })).toBeNull();
});


it.each(["clients", "classes"] as const)("warns about sparse %s even when the total has ten observations", kind => {
  const scenario = entryResults();
  const id = kind === "clients" ? "client" : "checkout";
  const entries = scenario.summary.variants[0].points[0].aggregate.entries;
  entries[kind][id] = { ...entries[kind][id], successRate: { ...entries[kind][id].successRate!, count: 2 } };
  render(<SummaryTable {...scenario} catalog={catalog} />);
  fireEvent.click(screen.getByText(kind === "clients" ? "By clients" : "By request types", { exact: true }));
  const table = screen.getByRole("table", { name: `${kind === "clients" ? "Client" : "Request type"} · ${id}` });
  expect(table.textContent).toContain("Unreliable interval: increase Replications.");
});

it("does not resurrect base default requests replaced in every saved variant", () => {
  const run = structuredClone(summary);
  for (const variant of run.variants) variant.points[0].aggregate.entries = {
    ...variant.points[0].aggregate.entries, clients: { client: variant.points[0].aggregate.entries.total },
    classes: { checkout: variant.points[0].aggregate.entries.total },
  };
  const variants = run.variants.map(variant => ({ ...variant, overrides: {
    "client.classes": [{ id: "checkout", load: { points: [{ time: "0s", rate: "20/s" }] } }],
  } }));
  render(<SummaryTable summary={run} model={model} catalog={outputCatalog as typeof catalog} variants={variants} />);
  expect(screen.queryByText("By request types", { exact: true })).toBeNull();
});
