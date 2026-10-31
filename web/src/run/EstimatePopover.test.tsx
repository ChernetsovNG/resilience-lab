import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { EstimatePopover } from "./EstimatePopover";

it("keeps estimate details open while a confirmation handles pointer and Escape", () => {
  const close = vi.fn();
  render(<><EstimatePopover onClose={close}>Estimated cost</EstimatePopover>
    <dialog open><button type="button">Stay</button></dialog></>);
  const action = screen.getByRole("button", { name: "Stay" });
  fireEvent.pointerDown(action);
  fireEvent.keyDown(action, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(close).toHaveBeenCalledTimes(1);
});
