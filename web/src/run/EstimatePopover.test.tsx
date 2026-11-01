import { fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import { EstimatePopover } from "./EstimatePopover";

it.each(["button", "outside", "Escape"])("handles %s dismissal before passive effects run", way => {
  const close = vi.fn();
  function DismissOnMount() {
    useLayoutEffect(() => {
      // A later sibling observes the committed estimate before passive effects run.
      fireEvent.pointerDown(screen.getByRole("region", { name: "Estimate" }));
      expect(close).not.toHaveBeenCalled();
      if (way === "button") fireEvent.click(screen.getByRole("button", { name: "Close estimate" }));
      else if (way === "outside") fireEvent.pointerDown(document.body);
      else fireEvent.keyDown(document, { key: "Escape" });
    }, []);
    return null;
  }
  render(<><EstimatePopover onClose={close}>Estimated cost</EstimatePopover><DismissOnMount /></>);
  expect(close).toHaveBeenCalledTimes(1);
});

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
