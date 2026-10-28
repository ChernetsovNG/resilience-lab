import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { summary } from "../test/fixtures";
import { ResultsPanel } from "./ResultsPanel";

it("lists all diagnostics in Problems and navigates from a finding", () => {
  const finding = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "At least one handler", document: "chain.model.json", pointer: "/blocks/gateway/params/handlers", path: "gateway", variant: "baseline" };
  const onDiagnostic = vi.fn();
  render(<ResultsPanel job={null} summary={null} problem={null} diagnostics={[
    finding, { code: "MODEL_EMPTY", severity: "WARNING", message: "No element location", document: null, pointer: null, path: null },
  ]} onDiagnostic={onDiagnostic} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  const panel = screen.getByRole("tabpanel");
  expect(within(panel).getByText(/chain.model.json#\/blocks\/gateway\/params\/handlers/)).toBeTruthy();
  expect(within(panel).getByText(/No element location/)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: /At least one handler/ }).textContent).toContain("baseline");
  fireEvent.click(within(panel).getByRole("button", { name: /At least one handler/ }));
  expect(onDiagnostic).toHaveBeenCalledWith(finding);
});

it("selects a grid point by ID and coordinates, but hides the selector without a grid", () => {
  const grid = structuredClone(summary);
  grid.grid = [{ path: "gateway-to-middle.timeout", values: ["40ms", "80ms"] }];
  const point = grid.variants[0].points[0];
  grid.variants[0].points = [
    { ...point, id: "p0", coordinates: { "gateway-to-middle.timeout": "40ms" } },
    { ...point, id: "p1", coordinates: { "gateway-to-middle.timeout": "80ms" } },
  ];
  const onPointChange = vi.fn();
  const view = render(<ResultsPanel job={null} summary={grid} problem={null} selectedPointId="p0" onPointChange={onPointChange} />);
  const selector = screen.getByRole("combobox", { name: "Grid point" });
  expect(within(selector).getByRole("option", { name: /p0.*gateway-to-middle\.timeout = 40ms/ })).toBeTruthy();
  expect(within(selector).getByRole("option", { name: /p1.*gateway-to-middle\.timeout = 80ms/ })).toBeTruthy();

  fireEvent.change(selector, { target: { value: "p1" } });
  expect(onPointChange).toHaveBeenCalledWith("p1");

  view.rerender(<ResultsPanel job={null} summary={summary} problem={null} selectedPointId="p0" onPointChange={onPointChange} />);
  expect(screen.queryByRole("combobox", { name: "Grid point" })).toBeNull();
});
