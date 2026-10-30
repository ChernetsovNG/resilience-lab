import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { costEstimate } from "../test/fixtures";
import { CostEstimate } from "../run/CostEstimate";
import { EstimatePopover } from "../run/EstimatePopover";

it.each(["hover", "focus", "click"])("opens field help by %s with an accessible name", action => {
  render(<CostEstimate estimate={costEstimate} />);
  const button = screen.getByRole("button", { name: "More about: Tasks" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  if (action === "hover") fireEvent.mouseEnter(button);
  if (action === "focus") fireEvent.focus(button);
  if (action === "click") fireEvent.click(button);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.textContent).toContain("variant × grid point × replication");
  expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
  expect(screen.getByLabelText("Tasks").getAttribute("aria-describedby")).toBe(tooltip.id);
});

it("closes help with Escape without closing the enclosing Estimate", () => {
  const onClose = vi.fn();
  render(<EstimatePopover onClose={onClose}><CostEstimate estimate={costEstimate} /></EstimatePopover>);
  fireEvent.click(screen.getByRole("button", { name: "More about: Tasks" }));
  fireEvent.keyDown(screen.getByRole("tooltip"), { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Estimate" })).toBeTruthy();
});

it("closes help on an outside click", () => {
  render(<CostEstimate estimate={costEstimate} />);
  fireEvent.click(screen.getByRole("button", { name: "More about: Tasks" }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("explains every Estimate value", () => {
  render(<CostEstimate estimate={costEstimate} />);
  for (const field of ["Tasks", "Workers", "Expected events", "Expected rows", "Estimated time", "Uncompressed size", "Artifact size", "Parts"]) {
    fireEvent.click(screen.getByRole("button", { name: "More about: " + field }));
    expect(screen.getByRole("tooltip").textContent!.length).toBeGreaterThan(25);
    fireEvent.keyDown(window, { key: "Escape" });
  }
});
