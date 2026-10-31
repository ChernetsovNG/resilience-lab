import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DiagnosticBadge, DiagnosticMessages, VariantDiagnosticBadge, VariantDiagnosticLinks } from "./DiagnosticDisplay";
import { DiagnosticLabelContext } from "../presentation/diagnosticContext";
import { catalog, model } from "../test/fixtures";
import { ProblemList } from "../layout/ProblemList";

const findings = [{ code: "CAPACITY", severity: "WARNING" as const, message: "Increase capacity", variant: "variant-2" }];

it("names generated variants in badges and diagnostic navigation without changing their targets", () => {
  const onSelect = vi.fn();
  render(<><VariantDiagnosticBadge diagnostics={findings} /><VariantDiagnosticLinks diagnostics={findings} onSelect={onSelect} /></>);
  expect(screen.getByRole("button", { name: "Warnings in variants: Variant 2" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "More about: Warnings in variants: Variant 2" }));
  const link = screen.getByRole("link", { name: "In variants: Variant 2 — 1 warning" });
  expect(link.getAttribute("href")).toBe("#variant-variant-2");
  fireEvent.click(link);
  expect(onSelect).toHaveBeenCalledWith("variant-2");
});

it("uses the actual document label in diagnostic badges and links", () => {
  render(<DiagnosticLabelContext value={{ variants: [{ id: "variant-2", label: "More connections" }] }}>
    <VariantDiagnosticBadge diagnostics={findings} />
    <VariantDiagnosticLinks diagnostics={findings} />
  </DiagnosticLabelContext>);
  expect(screen.getByRole("button", { name: "Warnings in variants: More connections" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "More about: Warnings in variants: More connections" }));
  expect(screen.getByRole("link", { name: "In variants: More connections — 1 warning" })).toBeTruthy();
});

it("resolves structured parameter names beside fields without changing their diagnostic identity", () => {
  const finding = { code: "PARAM_MISSING", severity: "ERROR" as const, message: "Missing handlers", path: "gateway", args: { parameter: "handlers" } };
  render(<DiagnosticLabelContext value={{ variants: [], catalog, model }}><DiagnosticMessages diagnostics={[finding]} /></DiagnosticLabelContext>);
  expect(screen.getByText("Required parameter 'Handlers · gateway' is missing")).toBeTruthy();
  expect(screen.getByText("PARAM_MISSING")).toBeTruthy();
  expect(finding.args.parameter).toBe("handlers");
});

it("resolves sweep points in ordinary field feedback and canvas badge tooltips", () => {
  const finding = { code: "LINT_HANDLERS_LITTLE", severity: "WARNING" as const, message: "Too few handlers (points: p0)", path: "gateway",
    args: { elementType: "service", handlers: 2, demand: 3, ratePerSecond: 1000, holdingMs: 3, points: "p0" } };
  render(<DiagnosticLabelContext value={{ variants: [], catalog, model, grid: [{ path: "gateway.processing.mean", values: ["3ms", "4ms"] }] }}>
    <DiagnosticBadge diagnostics={[finding]} /><DiagnosticMessages diagnostics={[finding]} />
  </DiagnosticLabelContext>);
  const coordinates = "Processing time · Mean · gateway = 3ms";
  expect(screen.getByRole("img", { name: "1 problems: warning" }).title).toContain(`(points: ${coordinates})`);
  fireEvent.click(screen.getByRole("button", { name: "More about: 1 problems: warning" }));
  expect(screen.getByRole("status").textContent).toContain(`(points: ${coordinates})`);
  expect(screen.getByRole("status").textContent).not.toMatch(/p0|gateway\.processing\.mean/);
  expect(finding.args.points).toBe("p0");
});

it("resolves execution task variants and points in API error explanations and their diagnostics", () => {
  const finding = { code: "EXECUTION_DRAIN", severity: "ERROR" as const, message: "Incomplete workload",
    args: { variant: "variant-2", point: "p1", replication: 3 } };
  render(<DiagnosticLabelContext value={{ variants: [{ id: "variant-2", label: "More capacity" }], catalog, model,
    grid: [{ path: "gateway.processing.mean", values: ["3ms", "4ms"] }] }}>
    <ProblemList problem={{ ...finding, diagnostics: [finding] }} />
  </DiagnosticLabelContext>);
  const expected = "Variant 'More capacity', point 'Processing time · Mean · gateway = 4ms', replication 3: Replication ended before the workload fully drained";
  expect(screen.getByRole("alert").querySelector("p")?.textContent).toBe(expected);
  expect(screen.getByRole("listitem").querySelector(".diagnostic-message")?.textContent).toBe(expected);
  expect(screen.getByRole("listitem").querySelector(".diagnostic-details")?.textContent).toContain("EXECUTION_DRAIN");
  expect(finding.args).toEqual({ variant: "variant-2", point: "p1", replication: 3 });
});
