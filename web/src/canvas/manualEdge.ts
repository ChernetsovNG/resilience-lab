import type { XYPosition } from "@xyflow/react";

export type EdgeControl = { kind: "segment" | "bend"; index: number };

/** Rendered turns include generated elbows and reversals, but exclude straight authored anchors. */
export function edgeBends(path: readonly XYPosition[]): { point: XYPosition; index: number }[] {
  return path.flatMap((point, index) => {
    const before = path[index - 1];
    const after = path[index + 1];
    if (before === undefined || after === undefined) return [];
    const incoming = { x: point.x - before.x, y: point.y - before.y };
    const outgoing = { x: after.x - point.x, y: after.y - point.y };
    return incoming.x * outgoing.y !== incoming.y * outgoing.x || incoming.x * outgoing.x + incoming.y * outgoing.y < 0
      ? [{ point, index }] : [];
  });
}

/** A gesture stores only internal anchors; ports always remain measured endpoints. */
export function editEdgePoints(path: readonly XYPosition[], anchors: readonly XYPosition[], control: EdgeControl, point: XYPosition | null): XYPosition[] | null {
  let edited: XYPosition[];
  if (control.kind === "bend") {
    const corner = path[control.index];
    const before = path[control.index - 1];
    const after = path[control.index + 1];
    if (corner === undefined || before === undefined || after === undefined) return null;
    if (point !== null) {
      edited = path.slice(1, -1).map((anchor, index) => ({ ...(index + 1 === control.index ? point : anchor) }));
    } else if (anchors.length === 1 && anchors[0].x === corner.x && anchors[0].y === corner.y) {
      // Deleting the final authored bend restores automatic routing.
      edited = [];
    } else {
      // The default connector could recreate the deleted elbow; take its opposite corner instead.
      const replacement = before.x === after.x || before.y === after.y ? []
        : [before.y === corner.y ? { x: before.x, y: after.y } : { x: after.x, y: before.y }];
      edited = [...path.slice(1, control.index), ...replacement, ...path.slice(control.index + 1, -1)].map(anchor => ({ ...anchor }));
    }
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
