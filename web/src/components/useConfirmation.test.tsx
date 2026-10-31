import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useState } from "react";
import { useConfirmation } from "./useConfirmation";

function Example() {
  const { confirm, confirmationDialog } = useConfirmation();
  const [decision, setDecision] = useState("Waiting");
  return <>
    <button onClick={async () => setDecision(String(await confirm({ title: "Discard edits?", message: "Your edits will be lost.",
      confirmLabel: "Discard edits", cancelLabel: "Stay" })))}>Switch model</button>
    <output>{decision}</output>
    {confirmationDialog}
  </>;
}

it("focuses the safe action, isolates editing shortcuts and restores focus after Escape", async () => {
  const shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  try {
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Switch model" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Discard edits?" });
    expect(dialog.getAttribute("aria-describedby")).toBe(within(dialog).getByText("Your edits will be lost.").id);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Stay" }));
    fireEvent.keyDown(document.activeElement!, { key: "z", ctrlKey: true });
    expect(shortcut).not.toHaveBeenCalled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await screen.findByText("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally { window.removeEventListener("keydown", shortcut); }
});

it("continues only after the explicit action is submitted", async () => {
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
  const dialog = await screen.findByRole("dialog", { name: "Discard edits?" });
  expect(screen.getByText("Waiting")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard edits" }));
  await waitFor(() => expect(screen.getByText("true")).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
});
