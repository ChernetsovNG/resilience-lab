import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EdgeEditControls } from "./EdgeEditControls";

const path = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 90 }, { x: 160, y: 90 }];
const toFlow = ({ x, y }: { x: number; y: number }) => ({ x: x / 2, y: y / 2 });
function setup() {
  const preview = vi.fn();
  const commit = vi.fn();
  const props = { id: "rpc", path, anchors: path.slice(1, -1), identity: {}, toFlow, onPreview: preview, onCommit: commit };
  return { ...render(<EdgeEditControls {...props} />), props, preview, commit };
}
function pointer(type: string, x: number, y: number, target: EventTarget = window) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 7 });
  act(() => { target.dispatchEvent(event); });
}

describe("edge edit controls", () => {
  it("previews a segment in flow coordinates, retaining its gesture target and committing only once", () => {
    const { commit, preview } = setup();
    const handle = screen.getByRole("button", { name: "Move segment 1 of rpc" });
    pointer("pointerdown", 70, 20, handle);
    pointer("pointermove", 90, 100);
    expect(commit).not.toHaveBeenCalled();
    expect(preview).toHaveBeenLastCalledWith([{ x: 10, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 90 }]);
    expect(screen.getByRole("button", { name: "Move segment 1 of rpc" })).toBe(handle);
    pointer("pointerup", 90, 100);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenLastCalledWith(null);
    pointer("pointerup", 90, 100);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("keeps a click and a parallel segment drag out of history", () => {
    const { commit } = setup();
    const handle = screen.getByRole("button", { name: "Move segment 1 of rpc" });
    pointer("pointerdown", 70, 20, handle); pointer("pointerup", 70, 20);
    pointer("pointerdown", 70, 20, handle); pointer("pointermove", 100, 20); pointer("pointerup", 100, 20);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["Escape", "pointercancel", "blur", "unmount", "identity"])("cancels without committing on %s", reason => {
    const { commit, preview, unmount, rerender, props } = setup();
    pointer("pointerdown", 120, 20, screen.getByRole("button", { name: "Move bend 1 of rpc" }));
    pointer("pointermove", 140, 40);
    if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "unmount") unmount();
    else if (reason === "identity") rerender(<EdgeEditControls {...props} identity={{}} />);
    else fireEvent(window, new Event(reason));
    pointer("pointerup", 140, 40);
    expect(commit).not.toHaveBeenCalled();
    expect(preview).toHaveBeenLastCalledWith(null);
  });

  it("moves an authored bend and removes it on double click", () => {
    const { commit } = setup();
    const handle = screen.getByRole("button", { name: "Move bend 1 of rpc" });
    pointer("pointerdown", 120, 20, handle); pointer("pointermove", 140, 40); pointer("pointerup", 140, 40);
    expect(commit).toHaveBeenLastCalledWith([{ x: 70, y: 20 }, path[2]]);
    fireEvent.doubleClick(handle);
    expect(commit).toHaveBeenLastCalledWith([path[2]]);
  });
});


it("rejects an oversized gesture visibly and leaves it out of history", () => {
  const commit = vi.fn();
  const preview = vi.fn();
  const points = Array.from({ length: 52 }, (_, i) => ({ x: Math.floor(i / 2) * 20, y: Math.ceil(i / 2) * 20 }));
  render(<EdgeEditControls id="rpc" path={points} anchors={points.slice(1, -1)} identity={{}} toFlow={toFlow} onPreview={preview} onCommit={commit} />);
  pointer("pointerdown", 0, 20, screen.getByRole("button", { name: "Move segment 1 of rpc" }));
  pointer("pointermove", 30, 20);
  expect(screen.getByRole("status").textContent).toContain("at most 50 points");
  expect(preview).toHaveBeenLastCalledWith(null);
  pointer("pointerup", 30, 20);
  expect(commit).not.toHaveBeenCalled();
});

it("ignores a second pointer and permits keyboard segment movement and bend deletion", () => {
  const { commit } = setup();
  const handle = screen.getByRole("button", { name: "Move segment 1 of rpc" });
  pointer("pointerdown", 70, 20, handle);
  const other = new MouseEvent("pointerup", { bubbles: true, clientX: 70, clientY: 60 });
  Object.defineProperty(other, "pointerId", { value: 8 });
  fireEvent(window, other);
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  expect(commit).toHaveBeenLastCalledWith([{ x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 90 }]);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move bend 1 of rpc" }), { key: "Delete" });
  expect(commit).toHaveBeenLastCalledWith([path[2]]);
});
