import type { XYPosition } from "@xyflow/react";

export type EdgeControl = { kind: "segment" | "bend"; index: number };

/** A gesture stores only internal anchors; ports always remain measured endpoints. */
export function editEdgePoints(path: readonly XYPosition[], anchors: readonly XYPosition[], control: EdgeControl, point: XYPosition | null): XYPosition[] | null {
  let edited: XYPosition[];
  if (control.kind === "bend") {
    edited = anchors.flatMap((anchor, index) => index !== control.index ? [{ ...anchor }] : point === null ? [] : [{ ...point }]);
  } else {
    if (point === null || path[control.index + 1] === undefined) return null;
    const axis = path[control.index].y === path[control.index + 1].y ? "y" : "x";
    const shifted = path.map((anchor, index) => index === control.index || index === control.index + 1
      ? { ...anchor, [axis]: point[axis] } : { ...anchor });
    if (control.index === 0) shifted.unshift({ ...path[0] });
    if (control.index + 1 === path.length - 1) shifted.push({ ...path.at(-1)! });
    edited = shifted.slice(1, -1);
  }
  return edited.length > 50 || edited.some(anchor => !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) ? null : edited;
}
